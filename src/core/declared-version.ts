import type { Store } from "../storage/client.ts";

/**
 * 目录声明版本的「探测 → 采纳 → 回滚」策略。
 *
 * ## 为什么需要它（2026-11-08）
 *
 * 渠道向上游声明的客户端版本是硬编码常量，而上游会按声明版本对模型做
 * **每模型 `minimal_version` 闸门**裁剪（Qoder 的实测记录见
 * `vendor/ofm/src/qoder-catalog.ts` 的实验表）：版本落后时新模型（如
 * Qoduck）被服务端**静默**裁掉 —— 插件遵守「只发布动态发现的条目」，
 * 模型就这样凭空消失，只能等人工改常量。本模块把「声明版本」变成状态：
 * 定期用**真实只读目录请求**探测更高版本，验证通过才采纳，失效自动回滚。
 *
 * ## 判据（全部从严）
 *
 * - 候选响应必须是可解析的完整目录，且模型 id 集合**包含**当前生效版本
 *   的集合（缺任何一个既有模型都判该候选无效，记入硬拒绝）；
 * - 采纳**达到最大集合的最低候选**（单轮收敛到阶梯顶部，版本号保持
 *   「刚好过闸」的形态，不冒进）；
 * - 4xx / 解析失败 / 集合缺模型 = 硬拒绝（记住，不再试）；网络错误 /
 *   5xx / 超时 = 瞬态（不记，下轮再试）；
 * - 无增益不采纳 —— 没有新模型可解锁时**身份零漂移**。
 *
 * ## 边界（文档明示）
 *
 * 只管**目录平面**版本；各渠道的推理平面版本（如 qoder-wasm 的
 * `COSY_VERSION = '1.1.49'`）保持已验证常量不动 —— 目录解锁的模型若在
 * 推理端也有闸门，首次真实推理即暴露，届时按证据扩展。候选阶梯上限是
 * `major+1`，闸门更高时本轮无发现（已知边界，探测值永远有真实响应背书）。
 */

/** 每渠道的声明版本状态（kv 持久化，JSON）。 */
export interface DeclaredVersionState {
  /** 内置基线（vendor 常量），回滚终点；永不修改。 */
  baseline: string;
  adopted?: {
    version: string;
    adoptedAt: number;
    /** 采纳时的来源版本（当时的生效版本），用于展示与排查。 */
    from: string;
  };
  /** 硬拒绝记录（有界，只保留最近 50 条）。 */
  rejected: { version: string; at: number; reason: string }[];
}

export const catalogVersionKey = (provider: string) =>
  "catalog-version:" + provider;
export const catalogVersionProbeAtKey = (provider: string) =>
  "catalog-version-probe-at:" + provider;

/** 当前生效版本：采纳值优先，否则基线。 */
export const effectiveVersion = (state: DeclaredVersionState): string =>
  state.adopted?.version ?? state.baseline;

/**
 * 从生效版本生成候选阶梯（升序）：
 * 两个补丁步、三个次版本步、一个主版本步，共 6 个。
 * 版本形状不对（非三段数字）返回空 —— 宁可不探测，不猜未知形状。
 */
export function ladderCandidates(current: string): string[] {
  const parts = current.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return [];
  const [x, y, z] = parts.map(Number);
  return [
    `${x}.${y}.${z + 1}`,
    `${x}.${y}.${z + 2}`,
    `${x}.${y + 1}.0`,
    `${x}.${y + 2}.0`,
    `${x}.${y + 3}.0`,
    `${x + 1}.0.0`,
  ];
}

/** 从 kv 载入状态；形状或基线不符（vendor 常量升级过）时按基线重置。 */
export async function loadDeclaredVersion(
  store: Store,
  provider: string,
  baseline: string,
): Promise<DeclaredVersionState> {
  const saved = await store.call<Partial<DeclaredVersionState> | undefined>(
    "get",
    catalogVersionKey(provider),
  );
  if (
    saved &&
    typeof saved === "object" &&
    saved.baseline === baseline &&
    (!saved.adopted || typeof saved.adopted.version === "string")
  )
    return {
      baseline,
      ...(saved.adopted ? { adopted: saved.adopted } : {}),
      rejected: Array.isArray(saved.rejected) ? saved.rejected : [],
    };
  return { baseline, rejected: [] };
}

export async function saveDeclaredVersion(
  store: Store,
  provider: string,
  state: DeclaredVersionState,
): Promise<void> {
  await store.call("set", catalogVersionKey(provider), state);
}

/** 单个候选版本的探测结果（fetchCandidate 的返回，绝不抛错）。 */
export type CandidateOutcome =
  | { ok: true; ids: string[] }
  | { ok: false; transient: boolean; reason: string };

export interface ProbeOutcome {
  adopted?: { version: string; from: string; added: number };
  hardRejected: { version: string; at: number; reason: string }[];
  /** 本轮实际探测的候选数（阶梯剔除硬拒绝后）。 */
  checked: number;
}

/**
 * 跑一轮探测：并行取所有候选的目录，按判据选采纳值。
 *
 * ⚠️ `fetchCandidate` 必须自己兜住异常（网络失败返回
 * `{ok:false, transient:true}`），本函数不吞调用方抛错之外的任何东西 ——
 * 它自身也不抛错，探测失败在结果里表现为「无采纳 + 硬拒绝清单」。
 */
export async function runVersionProbe(
  options: {
    state: DeclaredVersionState;
    currentIds: string[];
    fetchCandidate: (version: string) => Promise<CandidateOutcome>;
  },
  now = Date.now(),
): Promise<ProbeOutcome> {
  const { state, currentIds, fetchCandidate } = options;
  const from = effectiveVersion(state);
  const rejectedVersions = new Set(state.rejected.map((r) => r.version));
  const candidates = ladderCandidates(from).filter(
    (v) => !rejectedVersions.has(v),
  );
  const hardRejected: ProbeOutcome["hardRejected"] = [];
  if (candidates.length === 0) return { hardRejected, checked: 0 };
  // Promise.all 保持序：outcomes 与 candidates 同序（升序），找「最低」直接线性找。
  const outcomes = await Promise.all(
    candidates.map(async (version) => ({
      version,
      result: await fetchCandidate(version),
    })),
  );
  const valid: { version: string; ids: string[] }[] = [];
  for (const { version, result } of outcomes) {
    if (!result.ok) {
      if (!result.transient)
        hardRejected.push({ version, at: now, reason: result.reason });
      continue;
    }
    // 缺既有模型 = 该候选会倒退，绝不采纳（硬拒绝）。不用 Set 求差：
    // 目录是几十条的量级，线性过滤足够且不引入额外分配。
    const missing = currentIds.filter((id) => !result.ids.includes(id));
    if (missing.length > 0) {
      hardRejected.push({
        version,
        at: now,
        reason: "目录缺少既有模型：" + missing.join("、"),
      });
      continue;
    }
    valid.push({ version, ids: result.ids });
  }
  if (valid.length === 0) return { hardRejected, checked: candidates.length };
  // 最大集合；并列时取「达到该集合的最低候选」—— 同尺寸但内容不同属于
  // 上游异常，按成员资格判等即可（同尺寸 + 全包含 = 集合相等）。
  let maxIds = valid[0].ids;
  for (const v of valid) if (v.ids.length > maxIds.length) maxIds = v.ids;
  if (maxIds.length <= currentIds.length)
    return { hardRejected, checked: candidates.length };
  const lowest = valid.find(
    (v) => v.ids.length === maxIds.length && maxIds.every((id) => v.ids.includes(id)),
  );
  if (!lowest) return { hardRejected, checked: candidates.length };
  return {
    adopted: { version: lowest.version, from, added: maxIds.length - currentIds.length },
    hardRejected,
    checked: candidates.length,
  };
}

/** 把探测结果写回状态：采纳 + 硬拒绝入账（拒绝记录有界）。 */
export function applyProbeOutcome(
  state: DeclaredVersionState,
  outcome: ProbeOutcome,
  now = Date.now(),
): DeclaredVersionState {
  const rejected = [
    ...state.rejected,
    ...outcome.hardRejected.map((r) => ({ ...r, at: r.at || now })),
  ].slice(-50);
  if (!outcome.adopted) return { ...state, rejected };
  return {
    ...state,
    rejected,
    adopted: {
      version: outcome.adopted.version,
      adoptedAt: now,
      from: outcome.adopted.from,
    },
  };
}

/** 清除采纳（回滚到基线）；未采纳时原样返回。 */
export function rollbackAdoption(
  state: DeclaredVersionState,
): DeclaredVersionState {
  return state.adopted ? { ...state, adopted: undefined } : state;
}

/** 探测轮的最小间隔（毫秒）：默认 24h，测试用环境变量置 0。 */
export function probeIntervalMs(env = process.env): number {
  const raw = env.CHANNEL_HUB_VERSION_PROBE_MIN_MS;
  if (raw === undefined || raw === "") return 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 24 * 60 * 60 * 1000;
}
