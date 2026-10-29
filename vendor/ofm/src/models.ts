import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 曾返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 *
 * ⚠️ **自 2026-10 起已失效，不再请求**（见 {@link fetchCodeArtsRemoteModels}）。
 * 上游关闭免费权益通道后，该端点恒返回 HTTP 200 +
 * `{"error_code":"4000","error_msg":"invalid channel, group not found"}`
 * （`result` 为 null）。实测同一通道上的兄弟端点一并失效：
 * `/api/v1/user/tokens/balance` 同样 4000、`/v1/benefit-gateway-config` 直接
 * APIG.0101「API does not exist」。改参数（channel / group 各种组合）与
 * 改请求头均无效 —— 不是我们调错，是通道整体下线。
 *
 * 保留常量仅为文档与回归排查留证；正常路径不应再引用它发请求。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json'

/**
 * 远端不可用时的 benefit 模型兜底集合。
 *
 * ## ⚠️ 当前为空，这是刻意的（2026-10-28）
 *
 * 2026-10 上游关闭免费权益（benefit）通道后，码道**只剩积分通道**：目录里
 * 每个模型都带 `credit[].ratio_display`，按积分真实扣费，不再有免费额度模型。
 * 此时再给模型带 `maas_type: benefit` 会被上游**明确拒绝**。真实复测
 * （2026-10-28，本机账号）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `glm-5.3` 不带 `maas_type` | 200，正常出流 |
 * | `glm-5.3` 带 `maas_type: benefit` | 200 + `InferHub.4004.200 benefit not found` |
 *
 * 而旧实现的兜底集合里正好有 `glm-5.3-flash` / `deepseek-v4.1-flash`，于是
 * **每个 benefit 模型的请求都固定先带错头失败一次**，再由
 * `llm-adapter.ts` 的 `benefitHeaderDropped` 去掉该头重试才成功 —— 白花一次
 * 往返。账本实证：`codearts` 87 次成功请求里记着 235 条 `HTTP 400` attempt。
 *
 * 故清空此表，令 {@link isCodeArtsBenefitModel} 恒为 false。**判定逻辑本身
 * 保留**（含 `benefit not found` 的一次性重试）：华为若重开活动，只需把模型
 * id 填回这里，无需回滚代码。
 *
 * ## 历史实证（通道仍在时有效，留作协议参考）
 *
 * benefit 模型调用必须带 `maas_type: benefit`（参与 SDK-HMAC-SHA256 签名），
 * 否则后端返回 `InferHub.002002009.404 The model is not registered`。该集合
 * 的权威来源曾是 `opengw gateway/config` 的 `result.models`（现已失效，见
 * {@link OPENGW_GATEWAY_CONFIG_URL}）。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）从来**不在**此集合：
 * 它们是后端另外注册的非 benefit 模型，带上 maas_type 会报 unsupported model。
 */
export const CODEARTS_BENEFIT_FALLBACK: readonly string[] = []

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
  /**
   * 上游下发的上下文窗口（若该端点带）。
   *
   * ⚠️ **上游不带就留 `undefined`，不要拿静态表硬填**（2026-10-24）：
   * 两个端点（`gateway/config` 的 `result.models`、`snap-access` 的
   * `builtinModels`）实测只保证 `model_id` / `model_name`，字段名也可能变。
   * 这里做**宽容读取**：认得出来就透传，认不出来交给 `llm-adapter.ts` 的
   * `CONTEXT_WINDOWS` 静态表按 id 兜底 —— 那张表是人工核对过的。
   */
  contextWindow?: number
  /** 上游下发的单次输出上限（若该端点带）。 */
  maxTokens?: number
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache: string[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

/**
 * 把上游目录里的一条模型条目解析成 {@link RemoteModel}。
 *
 * 过滤规则：id 为空、视觉（VL）模型、重复 id 一律返回 `undefined`。
 * 上下文窗口与输出上限是**宽容读取**（多个可能的字段名 + 字符串形态），
 * 认不出来就留 `undefined` —— 见 {@link RemoteModel.contextWindow}。
 *
 * @param m 上游条目（`gateway/config` 的 `result.models[]` 或 `builtinModels[]`）。
 * @param seen 已见过的 id 集合（跨条目去重，调用方持有）。
 */
export function parseModelInfo(m: Record<string, unknown>, seen: Set<string>): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  const id = normalizeModelId(rawId)
  // 过滤视觉（VL）多模态模型
  // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
  // 不适合当 agent 主模型，从列表隐藏；只通过 analyzeImage 等工具间接调用。
  //
  // ⚠️ **必须大小写不敏感**（2026-10-28 修正）：实测码道目录里有
  // `kimi-k2.6-vl`（全小写），旧判据只认大写 `-VL` / `-VL-`，于是它通过了
  // 本函数 —— 与 `llm-adapter.ts` 的 `listAllModels`（那里用了 `/i`）判据
  // 不一致。虽然 `listAllModels` 兜住了最终菜单，但任何**直接用本函数产物**
  // 的调用方（如 `availableCodeArtsModels()`）都会把小写 VL 模型放进来。
  // 判据统一为大小写不敏感，两处口径一致。
  if (isVisualModelId(id)) return undefined
  const rawName = m['model_name']
  const name = typeof rawName === 'string' && rawName.length > 0 ? normalizeModelId(rawName) : id
  if (seen.has(id)) return undefined
  seen.add(id)
  // 上下文窗口 / 输出上限：**宽容读取**，认不出来就留 undefined。
  // ⚠️ 不要在这里补默认值：编造窗口会让 DSH 的自动压缩按错误阈值工作
  // （见 `models.ts` 里 `RemoteModel.contextWindow` 的说明）。
  const contextWindow = positiveInt(
    m['context_window'] ?? m['contextWindow'] ?? m['max_input_tokens'] ?? m['maxInputTokens'],
  )
  const maxTokens = positiveInt(
    m['max_tokens'] ?? m['maxTokens'] ?? m['max_output_tokens'] ?? m['maxOutputTokens'],
  )
  return {
    id,
    name,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

/** 只接受有限正数（浮点向下取整）；其余返回 undefined。 */
function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

/**
 * 判断模型 id 是否为视觉（VL）多模态模型。
 *
 * 视觉模型上下文小、不支持工具调用，不适合当 agent 主模型，故一律从目录
 * 中隐藏（只通过 analyzeImage 等工具间接调用）。
 *
 * ## 为什么抽成函数
 *
 * 判据原本在 `models.ts` 的 `parseModelInfo` 与 `llm-adapter.ts` 的
 * `listAllModels` **各写一遍**，而且口径不同：前者只认大写 `-VL` / `-VL-`，
 * 后者用了 `/i`。实测码道目录有全小写的 `kimi-k2.6-vl` —— 结果一处放行、
 * 另一处拦截，最终菜单虽然正确，但 `parseModelInfo` 的产物（如
 * `availableCodeArtsModels()`）会漏进小写 VL 模型。
 *
 * 现在只有这一个实现，两处共用，**大小写不敏感**。新增调用方请直接引用它，
 * 不要再复制判据。
 *
 * @param id - 模型 id（大小写不限）。
 * @returns 命中 `-VL-` 或以 `-VL` 结尾时为 true。
 */
export function isVisualModelId(id: string): boolean {
  return /-VL-/i.test(id) || /-VL$/i.test(id)
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
  /** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array())
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  if (extraUnsignedHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v)
  }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 从远端端点拉取模型列表并合并去重。
 *
 * ## 当前只有一个端点（2026-10-28 起）
 *
 * `snap-access /v1/model/builtin` → `builtinModels`（全部现存模型）。
 *
 * 此处**不再**请求 `opengw gateway/config`：该端点为 benefit（免费额度）模型
 * 清单服务，随免费权益通道于 2026-10 下线，恒返回
 * `4000 invalid channel, group not found`（详见
 * {@link OPENGW_GATEWAY_CONFIG_URL}）。每次刷新都白打一次必然失败的请求，
 * 也拿不到任何模型。
 *
 * 连带影响：benefit id 集合不再由远端填充，改由
 * {@link CODEARTS_BENEFIT_FALLBACK}（当前为空）决定，见
 * {@link isCodeArtsBenefitModel}。
 *
 * 失败或空凭据时返回空数组（不阻断）。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = fetch,
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) return []

  const models: RemoteModel[] = []
  const seen = new Set<string>()

  // snap-access /v1/model/builtin — 现存全部模型（GLM-5.2、glm-5.3、openpangu 等）
  //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
  //    替代旧 statistics/plugin（已不再返回 model_metrics）。
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    'Content-Type': 'application/json',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
  })
  if (snapText !== undefined) {
    const arr = extractJsonArray(snapText, ['builtinModels'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  return models
}

/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 *
 * @param directory - 缓存目录；传 `undefined` 表示**关闭磁盘缓存**（不读不写），
 *   单测收尾时用它将状态复位，避免上一个用例的缓存目录泄漏到下一个用例。
 */
let hubCache:string|undefined
export function configureHubCache(directory:string|undefined):void {hubCache=directory;memoryCache=undefined;benefitMemoryCache=undefined;}
function cacheDir():string|undefined {return hubCache}


/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`
}

/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(models), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    return Array.isArray(models) && models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}

/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ **当前无调用方，保留仅为后备**（2026-10-28）：写入方曾是
 * `fetchCodeArtsRemoteModels` 的 gateway/config 分支，该端点下线后已移除。
 * 若将来恢复 benefit 通道（填回 {@link CODEARTS_BENEFIT_FALLBACK} 或重新接
 * 远端清单），可由写入方调用本函数与 {@link setBenefitMemoryCache}；届时
 * {@link isCodeArtsBenefitModel} 也需相应改回读取缓存。
 */
export function saveBenefitCache(ids: readonly string[]): void {
  const path = benefitCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(ids), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/**
 * 加载缓存文件中的 benefit 模型 id 集合；文件不存在或解析失败时返回 undefined。
 *
 * ⚠️ **当前无调用方，保留仅为后备**：该文件的唯一写入方是已下线的
 * gateway/config 分支，用户机器上残留的旧文件记录的是通道关闭前的历史模型。
 * {@link isCodeArtsBenefitModel} **刻意不再读它** —— 让一份死数据继续决定
 * 是否发 `maas_type` 正是坏处所在。用途仅限日后恢复通道时的人工排查/迁移。
 */
export function loadBenefitCache(): string[] | undefined {
  const path = benefitCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const ids: unknown = JSON.parse(text)
    if (!Array.isArray(ids) || ids.length === 0) return undefined
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/**
 * 设置 benefit 集合内存缓存（undefined 表示清除）。
 *
 * ⚠️ **当前无调用方，保留仅为后备**：见 {@link saveBenefitCache}。
 */
export function setBenefitMemoryCache(ids: string[] | undefined): void {
  benefitMemoryCache = ids
}

/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否带
 * `maas_type: benefit`。
 *
 * ## 现在只看静态表，且该表为空（2026-10-28）
 *
 * 旧实现按「内存缓存 → 磁盘缓存（远端拉取所得）→ 静态兜底」三级判定。远端那
 * 一级随 `gateway/config` 下线后已无写入方，**磁盘上的旧缓存文件却会永久留在
 * 用户机器上**：它记录的是通道关闭前的历史模型，继续读它等于让一份死数据
 * 长期决定是否发 `maas_type`。故这里不再读缓存，只看
 * {@link CODEARTS_BENEFIT_FALLBACK}（当前为空 → 恒 false）。
 *
 * ⚠️ 判定**不是**「名字里带 flash」这类猜测：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却曾相反。当年唯一权威来源是
 * gateway/config 的模型清单 + 兜底表；前者已失效，只剩兜底表。
 *
 * 后备：华为若重开免费权益通道，把模型 id 填回 {@link CODEARTS_BENEFIT_FALLBACK}
 * 即可恢复发头，`llm-adapter.ts` 的 `benefit not found` 一次性重试逻辑仍在。
 */
export function isCodeArtsBenefitModel(model: string): boolean {
  return CODEARTS_BENEFIT_FALLBACK.includes(model)
}
