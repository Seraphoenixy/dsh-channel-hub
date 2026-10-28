import { authorizationLink } from "../host/browser.ts";
import { rateLabel } from "../core/rate.ts";
import { extendedTierLabel } from "../core/context.ts";
import { promotionsFromConfig } from "../core/promotion.ts";
import { AccountPool } from "../../vendor/ofm/src/account-pool.ts";
import { CodeArtsAuth } from "../../vendor/ofm/src/service.ts";
import { CodeArtsAdapter } from "../../vendor/ofm/src/llm-adapter.ts";
import { BuddyAuth } from "../../vendor/ofm/src/buddy-auth.ts";
import { BuddyAdapter } from "../../vendor/ofm/src/buddy-adapter.ts";
import { CODEBUDDY, WORKBUDDY } from "../../vendor/ofm/src/product.ts";
import {
  BUDDY_CN_PROVIDER,
  inspectBuddySystem,
} from "../system/buddy-system.ts";
import {
  fetchAuthState,
  decorateLoginUrl,
} from "../../vendor/ofm/src/buddy-oauth.ts";
import { parseQoderRemoteModels } from "../../vendor/ofm/src/qoder-catalog.ts";
import { QoderAuth } from "../../vendor/ofm/src/qoder-auth.ts";
import { QoderAdapter } from "../../vendor/ofm/src/qoder-adapter.ts";
import { QODER, QODER_CN } from "../../vendor/ofm/src/qoder-product.ts";
import { TraeAuth } from "../../vendor/ofm/src/trae-auth.ts";
import { TraeAdapter } from "../../vendor/ofm/src/trae-adapter.ts";
import { TRAE } from "../../vendor/ofm/src/trae-product.ts";
import { LoomyAuth } from "../../vendor/ofm/src/loomy-auth.ts";
import {
  LoomyAdapter,
  parseLoomyRemoteModels,
} from "../../vendor/ofm/src/loomy-adapter.ts";
import { LOOMY } from "../../vendor/ofm/src/loomy-product.ts";
import { RaccoonAuth } from "../../vendor/ofm/src/raccoon-auth.ts";
import { RaccoonAdapter } from "../../vendor/ofm/src/raccoon-adapter.ts";
import { RACCOON } from "../../vendor/ofm/src/raccoon-product.ts";
import { GeminiAuth } from "../../vendor/ofm/src/gemini-auth.ts";
import { GeminiAdapter } from "../../vendor/ofm/src/gemini-adapter.ts";
import { createGeminiSigStore } from "../../vendor/ofm/src/gemini-sigstore.ts";
import {
  GEMINI,
  GEMINI_ENDPOINTS,
  GEMINI_UPSTREAM_FLASH,
  geminiHeaders,
} from "../../vendor/ofm/src/gemini.ts";
import { discoverGemini } from "./gemini-catalog.ts";
import { syncQoderAccountName } from "./qoder-identity.ts";
import { AccountSelection } from "../core/account-selection.ts";
import { configureHubCache } from "../../vendor/ofm/src/models.ts";
import { buildCosyHeaders } from "../../vendor/connect/cosy.js";
import {
  fetchCreditBalanceDetailed,
  claimDailyCheckin,
} from "../../vendor/ofm/src/credits.ts";
import {
  fetchCodeArtsAccountInfoDetailed,
  claimCodeArtsDailyCheckin,
} from "../../vendor/ofm/src/codearts-credits.ts";
import {
  fetchQoderCreditBalanceDetailed,
  claimQoderDailyCheckin,
} from "../../vendor/ofm/src/qoder-credits.ts";
import {
  fetchTraeCreditBalanceDetailed,
  claimTraeDailyCheckin,
} from "../../vendor/ofm/src/trae-credits.ts";
import { fetchLoomyCreditBalanceDetailed } from "../../vendor/ofm/src/loomy-credits.ts";
import { fetchRaccoonCreditBalanceDetailed } from "../../vendor/ofm/src/raccoon-credits.ts";
import { fetchGeminiCreditBalance } from "../../vendor/ofm/src/gemini-credits.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { redact, credentialExpiry, describeHttpFailure } from "../core/types.ts";
const specs = [
  [
    "codearts",
    "华为码道",
    CodeArtsAuth,
    CodeArtsAdapter,
    { id: "codearts", defaultCredentialRef: "CODEARTS_ACCESS_TOKEN" },
  ],
  // CodeBuddy CN 与 WorkBuddy 国区是同一产品（同一 copilot.tencent.com 登录），
  // 只是一个渠道，不能拆成两个条目重复登录。
  ["buddy", "CodeBuddy / WorkBuddy CN", BuddyAuth, BuddyAdapter, CODEBUDDY],
  ["workbuddy", "WorkBuddy 国际版", BuddyAuth, BuddyAdapter, WORKBUDDY],
  ["qoder", "Qoder 国际版", QoderAuth, QoderAdapter, QODER],
  ["qodercn", "Qoder CN", QoderAuth, QoderAdapter, QODER_CN],
  // 旧 SOLO 已并入 Trae CN IDE，只保留一个 Trae 渠道；登录仍走 OFM 的
  // TraeAuth/ExchangeToken，仅把客户端与版本身份换成现役 CN IDE。
  [
    "trae",
    "Trae CN IDE",
    TraeAuth,
    TraeAdapter,
    {
      ...TRAE,
      displayName: "Trae CN IDE",
      clientId: "ono9krqynydwx5",
      ideVersion: "3.4.2",
      ideVersionCode: "1238630385922",
      function: "solo_agent",
      channels: ["solo_agent", "chat_v3", "builder_v3"],
    },
  ],
  ["loomy", "Loomy", LoomyAuth, LoomyAdapter, LOOMY],
  ["raccoon", "Raccoon", RaccoonAuth, RaccoonAdapter, RACCOON],
  ["gemini", "Gemini", GeminiAuth, GeminiAdapter, GEMINI],
];
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const expires = credentialExpiry;
/**
 * 把 DSH 的调用上下文折算成「轮次」信息。
 *
 * DSH 只下发 `sessionId`，**不向适配器提供 turn/step**。故按最后一条消息推断：
 * 纯用户消息视为**新一轮的开始**；`role:'tool'` 或内嵌 `tool-result` 的消息
 * （0.1.7 之前的旧形态把工具结果放在 user 消息里）以及 assistant 消息都属同一轮。
 *
 * ⚠️ 已知近似：压缩 / 标题生成等旁路调用若也以用户消息结尾，会被当成新的一轮。
 */
export const streamMeta = (opts) => {
  const messages = Array.isArray(opts?.messages) ? opts.messages : undefined;
  const last = messages?.at(-1);
  const content = last?.content;
  const hasToolResult =
    Array.isArray(content) &&
    content.some(
      (part) => part?.type === "tool-result" || part?.type === "tool_result",
    );
  return {
    ...(typeof opts?.sessionId === "string" ? { sessionId: opts.sessionId } : {}),
    startsTurn: last?.role === "user" && !hasToolResult,
  };
};
export async function createDrivers(ctx, { catalog, observer, store }) {
  configureHubCache(ctx.channelHubDataDir + "/catalog-cache");
  const directoryContext = new AsyncLocalStorage();
  const directoryFetch = async (input, init) => {
    const state = directoryContext.getStore();
    try {
      const response = await fetch(input, init);
      if (state) {
        if (!response.ok) {
          // ⚠️ 必须读响应体：403 同时覆盖「凭据失效 / 账号被禁用 / 额度耗尽 /
          // 无权限」四种语义，只留状态码等于没有原因（真实缺陷，2026-10-23）。
          // `clone()` 保证原响应仍可被下游正常消费。
          let detail = "";
          try {
            detail = await response.clone().text();
          } catch {
            detail = "";
          }
          state.error = describeHttpFailure("目录", response.status, detail);
        } else {
          try {
            const body = await response.clone().json();
            // 复用同一次目录请求：`/v3/config` 的 `data.modelPromotions` 带
            // 折扣时段与角标（夜间免费 / 夜间半价一类），OFM 只取其中「此刻
            // 折后价」，把时段丢掉了。这里顺手留下响应体，供本渠道附加
            // `promotion` 展示字段 —— 不新增端点、不重复请求。
            const url =
              typeof input === "string" ? input : (input?.url ?? String(input));
            if (url.endsWith("/v3/config")) state.config = body;
          } catch {
            state.error = "目录不是有效 JSON";
          }
        }
      }
      return response;
    } catch (e) {
      if (state) state.error = redact(e);
      throw e;
    }
  };
  const pool = new AccountPool(ctx),
    drivers = new Map(),
    pending = new Map();
  const selection = new AccountSelection(store, (id) => pool.findAccount(id));
  const read = async (a) => {
    const v = await ctx.credentials.resolve(a.credentialRef);
    return v ? parse(v.value) : undefined;
  };
  const readByRef = async (ref) => {
    const v = await ctx.credentials.resolve(ref);
    return v ? parse(v.value) : undefined;
  };
  const scopedPool = (account) =>
    new Proxy(pool, {
      get(t, k) {
        if (k === "listAccountsByProvider")
          return (p) =>
            pool.listAccountsByProvider(p).filter((a) => a.id === account.id);
        if (k === "getAvailableAccount")
          return async (p) =>
            p === account.provider
              ? { entry: account, credential: await read(account) }
              : undefined;
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      },
    });
  for (const [id, name, Auth, Adapter, base] of specs) {
    try {
      const product = { ...base, fallbackModels: [] };
      const auth = new Auth(ctx, {
        product,
        accountPool: pool,
        fetcher: directoryFetch,
        fetchImpl: directoryFetch,
      });
      const renewalJobs = new Map();
      const renewAccount = async (a) => {
        const existing = renewalJobs.get(a.id);
        if (existing) return existing;
        const task = auth
          .refreshAccountCredential(a.credentialRef, pool, a.id)
          .finally(() => renewalJobs.delete(a.id));
        renewalJobs.set(a.id, task);
        return task;
      };
      const choose = async (provider, model = "", excluded = new Set()) => {
        if (provider !== id) throw Error("账号池不能跨渠道选择");
        const requested = observer.context.getStore()?.requestedAccountId;
        if (requested) {
          selection.requireAccount(id, requested);
          if (excluded.has(requested)) return null;
        }
        const skipped = new Set(excluded);
        for (const a of pool.listAccountsByProvider(id)) {
          if (requested && a.id !== requested) {
            skipped.add(a.id);
            continue;
          }
          const snapshot = await catalog.load(id + ":" + a.id);
          if (model && !snapshot.models.some((m) => m.id === model)) {
            if (requested) throw Error("指定账号的动态目录不支持该模型，请更新模型或重新选择账号");
            skipped.add(a.id);
          }
        }
        const selected = await pool.getAvailableAccount(id, model, skipped);
        if (!selected && requested) throw Error("指定账号当前不可用：该模型处于限流冷却或凭据不可用，请在渠道中心处理");
        if (selected)
          observer.bindAccount(selected.entry.id, selected.entry.nickname);
        return selected;
      };
      const runtimePool = new Proxy(pool, {
        get(target, key) {
          if (key === "getAvailableAccount") return choose;
          if (key === "listAccountsByProvider")
            return (provider) => {
              const requested = observer.context.getStore()?.requestedAccountId;
              return pool.listAccountsByProvider(provider).filter((a) => !requested || a.id === requested);
            };
          if (key === "findAccountIdByCredential")
            return async (provider, identity) => {
              const bound = observer.context.getStore()?.accountId;
              const account = bound ? pool.findAccount(bound) : undefined;
              if (account?.provider === provider) {
                const credential = await read(account);
                if (credential?.[provider === "codearts" ? "access_key_id" : "access_token"] === identity) return account.id;
              }
              return pool.findAccountIdByCredential(provider, identity);
            };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const resolveCredential = async (model) =>
        (await choose(id, model ?? ""))?.credential;
      const refresh = async () => {
        const id = observer.context.getStore()?.accountId;
        const a = id ? pool.findAccount(id) : undefined;
        if (!a) throw Error("No request account to renew");
        await renewAccount(a);
      };
      const currentAccountId = () => observer.context.getStore()?.accountId;
      /**
       * Gemini 的 `thoughtSignature` 缓存。
       *
       * ⚠️ **必须每个渠道建一次并长期复用**（与 OFM 入口同口径）：它既是
       * 跨请求缓存，也要在停止时 `flush()` 落盘。现造等于每轮都从空缓存开始 ——
       * 上游会以
       * `Function call is missing a thought_signature in functionCall parts`
       * 400 拒绝（真实报障，2026-10-21）。
       *
       * 只有 Gemini 需要；其余渠道 `sigStore` 保持 `undefined`（适配器据此
       * 不做任何签名回填）。
       */
      const sigStore = id === "gemini" ? createGeminiSigStore(ctx) : undefined;
      /**
       * Gemini 信封里的 `project`（跨启动缓存）。
       *
       * ⚠️ 与 OFM 入口同口径：`project` **不是**恒为兜底串，缺省由适配器现探
       * `loadCodeAssist`。这里建一次、长期复用 —— 现造等于每轮都多打一次探测。
       */
      const projectCache = id === "gemini" ? new Map() : undefined;
      const options = {
        credentialRef: product.defaultCredentialRef,
        product,
        accountPool: runtimePool,
        resolveCredential,
        refresh,
        currentAccountId,
        readImage: async (ref) => {
          const attachment = ctx.get?.("attachments");
          if (!attachment?.readImage) throw Error("宿主未提供图片读取服务");
          const v = await attachment.readImage(ref);
          return { data: v.data, mediaType: v.ref?.mediaType ?? v.mediaType };
        },
        fetchImpl: observer.fetcher(fetch),
        fetchRemoteModels: async () => product.fallbackModels,
        catalogModels: () => product.fallbackModels,
        nextAccount: async (model, tried) => {
          const s = await choose(id, model, tried);
          if (!s) return;
          observer.bindAccount(s.entry.id, s.entry.nickname);
          return { accountId: s.entry.id, credential: s.credential };
        },
        isReady: async () => Boolean(await resolveCredential("")),
        // Buddy 国区的系统提示词整篇替换（策略与模板见 `src/system/buddy-system.ts`）。
        // ⚠️ 只在 `buddy` 上挂这个钩子：WorkBuddy 国际版没有被 11128 拦截，
        // 也没有这份模板的验收证据，不能顺带改动它的请求。
        ...(id === BUDDY_CN_PROVIDER
          ? {
              rewriteSystem: ({ system, model, purpose }) => {
                const verdict = inspectBuddySystem({
                  provider: id,
                  model,
                  system,
                  purpose,
                });
                if (verdict.replaced !== true) return undefined;
                if (verdict.reviewNeeded) {
                  // 换照做（用户要求无条件替换），但必须留痕：认不出宿主模板
                  // 说明 DSH 升级改过系统提示词，本模板可能漏掉新段落。
                  ctx.logger.warn(
                    "Buddy 国区：未识别的系统提示词模板（长度 " +
                      system.length +
                      "），已按已审阅模板整篇替换；请复核是否需要更新模板。",
                  );
                }
                return verdict.text;
              },
            }
          : {}),
        // 以下三项只有 Gemini 适配器读取；其余渠道忽略（`undefined`）。
        ...(sigStore === undefined ? {} : { sigStore }),
        ...(projectCache === undefined ? {} : { projectCache }),
        // 现探到**非兜底**的真值才回写凭据（best-effort，失败不影响推理）。
        // ⚠️ 回写对象必须是**本次解析凭据用的那个账号**，不是默认 ref ——
        // 写错会把另一个账号的项目号污染掉。
        ...(id !== "gemini"
          ? {}
          : {
              persistProject: async (value) => {
                const selected = await choose(id, "");
                if (!selected) return;
                await ctx.credentials.set(
                  selected.entry.credentialRef,
                  JSON.stringify({ ...selected.credential, cloudaicompanionProject: value }),
                );
              },
            }),
      };
      let adapter = new Adapter(options);
      const discover = async (account) =>
        directoryContext.run({}, async () => {
          const p = scopedPool(account),
            c = await read(account);
          if (!c) throw Error("账号凭据不可读取");
          let models;
          if (id === "qoder" || id === "qodercn") {
            await syncQoderAccountName({
              account, credential: c, product,
              getAccount: (accountId) => pool.findAccount(accountId),
              readCredential: read,
              updateAccount: (accountId, patch) => pool.updateAccount(accountId, patch),
            }).catch((error) => ctx.logger.warn("Qoder 账号名称更新失败：" + redact(error)));
            const url =
              product.encryptedInferBase + "/algo/api/v2/model/list?Encode=1";
            const response = await fetch(url, {
              headers: buildCosyHeaders(null, url, {
                userID: c.uid,
                authToken: c.security_oauth_token ?? c.access_token,
                machineID: c.machine_id,
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) {
              // 与 `directoryFetch` 同口径：带上响应体里的业务码/原因。
              let detail = "";
              try {
                detail = await response.text();
              } catch {
                detail = "";
              }
              throw Error(describeHttpFailure("目录", response.status, detail));
            }
            const raw = await response.json();
            if (!Array.isArray(raw.chat)) throw Error("目录缺少 chat 数组");
            models = parseQoderRemoteModels(raw);
            if (!models) throw Error("无法识别 Qoder 目录");
          } else if (id === "codearts") models = await auth.refreshModels(p);
          else if (id === "loomy") {
            const res = await fetch(LOOMY.apiBase + "/models", {
              headers: { Accept: "application/json", token: c.access_token },
              signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) {
              let detail = "";
              try {
                detail = await res.text();
              } catch {
                detail = "";
              }
              throw Error(describeHttpFailure("目录", res.status, detail));
            }
            models = parseLoomyRemoteModels(await res.json());
          } else if (id === "gemini")
            models = await discoverGemini({
              credential: c,
              headers: geminiHeaders(c, { includeAccept: true }),
              endpoints: GEMINI_ENDPOINTS,
              supportedId: GEMINI_UPSTREAM_FLASH,
            });
          else if (auth.fetchRemoteModelsOnly)
            models = await auth.fetchRemoteModelsOnly(p);
          else if (auth.fetchModels) models = await auth.fetchModels(p);
          else throw Error("渠道缺少动态目录接口");
          // 目录请求允许内部回退：WorkBuddy 国际版的企业模型端点
          // （/console/enterprises/personal/models）对个人账号返回 500，
          // 随后 /v3/config 仍能正常下发模型。只有最终**没有任何模型**时才把
          // 记录到的失败当作本次目录的失败，否则一个可选端点的 500 会让整次
          // 刷新失败、模型列表变空（实机报障：登录后「目录 HTTP 500 / 模型 0」）。
          const failure = directoryContext.getStore()?.error;
          if (!Array.isArray(models)) {
            if (failure) throw Error(failure);
            throw Error("Invalid remote catalog");
          }
          if (models.length === 0 && failure) throw Error(failure);
          // 腾讯系（buddy / workbuddy）的折扣带**每日时段**与角标（实测
          // 「夜间折扣」23:00–7:50）。OFM 只把「此刻折后价」写进
          // `discountedCreditsRate`，时段与角标被丢弃 —— 于是界面无法回答
          // 「夜间免费 / 夜间半价」这类问题。这里在**同一份** `/v3/config`
          // 响应上补一个 `promotion` 展示字段；不新增端点、不额外请求，
          // 也不改 vendor 快照。
          const promotions =
            id === "buddy" || id === "workbuddy"
              ? promotionsFromConfig(directoryContext.getStore()?.config)
              : undefined;
          return models.map((m) => {
            const model = {
              ...m,
              id: m.id ?? m.modelId ?? m.model_id,
              name: m.name ?? m.displayName ?? m.id,
            };
            const promotion = promotions?.get(model.id);
            return promotion === undefined ? model : { ...model, promotion };
          });
        });
      const hydrate = async () => {
        const requested = await selection.get(id);
        const snapshots = await Promise.all(
          pool
            .listAccountsByProvider(id)
            .filter((a) => a.enabled && (!requested || a.id === requested))
            .map((a) => catalog.load(id + ":" + a.id)),
        );
        product.fallbackModels = [
          ...new Map(
            snapshots.flatMap((s) => s.models).map((m) => [m.id, m]),
          ).values(),
        ];
        adapter = new Adapter(options);
      };
      const reload = async () => {
        const accounts = pool.listAccountsByProvider(id);
        const results = await Promise.all(
          accounts.map((a) =>
            catalog.refresh(id + ":" + a.id, () => discover(a)),
          ),
        );
        await hydrate();
        try {
          ctx.emit("llm/adapters-updated");
        } catch (e) {
          ctx.logger.warn("目录变更通知失败：" + redact(e));
        }
        return results;
      };
      const visible = async () => {
        const requested = await selection.get(id);
        const available = pool.listAccountsByProvider(id).filter((a) => a.enabled && (!requested || a.id === requested));
        if (available.length === 0) return [];
        const models = new Map();
        for (const a of available)
          for (const m of (await catalog.load(id + ":" + a.id)).models)
            models.set(m.id, m);
        const hidden = pool.disabledModelsFor(id);
        // 「大窗口档」是否启用 —— 只有 Trae 有这个概念，其余渠道恒 false。
        const extended = id === "trae" && product.maxMode === true;
        return [...models.values()]
          .filter((m) => !hidden.has(m.id))
          .map((m) => {
            const rate = rateLabel(m);
            /**
             * 大窗口档后缀：`1M`。
             *
             * ⚠️ 必须拼进 `name`（模型菜单只渲染 name，见 `traeDisplayName`
             * 的同一条理由）；且**只在真正启用时**拼 —— 未启用却写 1M 会让
             * 用户以为已经在用大窗口。
             */
            const tier = extendedTierLabel(m, extended);
            const decorated =
              (rate === undefined ? m.name : m.name + " · " + rate) +
              (tier === undefined ? "" : " · " + tier);
            return {
              ...m,
              inputModalities:
                m.supportsImage === true || m.supportsImages === true
                  ? ["text", "image"]
                  : ["text"],
              provider: "channel-hub/" + id,
              name: decorated,
            };
          });
      };
      const streamWithSelection = async function* (opts, model, run, signal) {
        const requestedAccountId = await selection.get(id);
        yield* observer.stream(id, model, run, signal, {
          ...streamMeta(opts),
          ...(requestedAccountId ? { requestedAccountId } : {}),
        });
      };
      const exposed = new Proxy(adapter, {
        get(_t, k) {
          if (k === "providerInfo")
            return () => ({ id: "channel-hub/" + id, name });
          if (k === "listModels" || k === "listAllModels") return visible;
          if (k === "resolveModel")
            return async (_p, m, signal) => ({
              ...(await adapter.resolveModel(id, m, signal)),
              provider: "channel-hub/" + id,
            });
          if (k === "prepareCall")
            return async (_p, m, signal) => {
              if (!(await visible()).some((x) => x.id === m))
                throw Error("模型未在动态目录中启用");
              const prepared = await adapter.prepareCall(id, m, signal);
              return {
                ...prepared,
                model: { ...prepared.model, provider: "channel-hub/" + id },
                stream: (opts) =>
                  streamWithSelection(
                    opts,
                    m,
                    (signal) =>
                      prepared.stream({ ...opts, provider: id, signal }),
                    opts.signal ?? signal,
                  ),
              };
            };
          if (k === "stream")
            return (opts) =>
              streamWithSelection(
                opts,
                opts.model,
                (signal) => adapter.stream({ ...opts, provider: id, signal }),
                opts.signal,
              );
          const value = adapter[k];
          return typeof value === "function" ? value.bind(adapter) : value;
        },
      });
      const registration = ctx.llm.registerAdapter(
        ["channel-hub/" + id],
        exposed,
      );
      /**
       * 额度查询。
       *
       * 一律优先调用**带原因的** `…Detailed` 变体，把上游的 `code` / `msg`
       * 一并交给余额服务落库。旧实现只调 `null` 版本，于是 LobsterAI 账号被
       * 禁用（`403 {"code":40302,"message":"账号已被禁用"}`）时，界面只能显示
       * 「凭据失效或响应异常」—— 把用户引向「重新登录」这个无效动作。
       *
       * 各渠道的返回形状统一为 `{ balance, error? }`；`balance !== null` 即成功。
       */
      const balance = async (a) => {
        const c = await read(a);
        if (!c) throw Error("凭据不可读取");
        if (id === "codearts") {
          // codearts 早已备好带原因的版本，只是此前没人调用。
          const result = await fetchCodeArtsAccountInfoDetailed(c);
          if (!result.ok) return { balance: null, error: result.message };
          // 成功时**原样**返回 `CodeArtsAccountInfo`：它自己带 `isCreditPackage`，
          // 由 `core/credits.ts` 的 `fromCodeArts` 区分「积分账户」与「非积分账户」
          // ——后者是正常的账户类型差异，要显示 note 而不是错误。
          return result.info;
        }
        if (id === "buddy" || id === "workbuddy")
          return fetchCreditBalanceDetailed(c, product);
        if (id.startsWith("qoder"))
          return fetchQoderCreditBalanceDetailed(c, product);
        if (id.startsWith("trae"))
          return fetchTraeCreditBalanceDetailed(c, product);
        if (id === "loomy") return fetchLoomyCreditBalanceDetailed(c, product);
        if (id === "raccoon")
          return fetchRaccoonCreditBalanceDetailed(product, c);
        if (id === "gemini") return fetchGeminiCreditBalance(c, product);
        if (auth.fetchCreditBalance) return auth.fetchCreditBalance(c);
        if (auth.fetchBalanceFor) return auth.fetchBalanceFor(c);
        throw Error("该渠道未提供额度查询");
      };
      const claim = [
        "codearts",
        "buddy",
        "qoder",
        "qodercn",
        "trae",
        "loomy",
        "raccoon",
      ].includes(id)
        ? async (a) => {
            const c = await read(a);
            if (!c) throw Error("凭据不可读取");
            if (id === "codearts") return claimCodeArtsDailyCheckin(c);
            if (id === "buddy") return claimDailyCheckin(c, product);
            if (id.startsWith("qoder"))
              return claimQoderDailyCheckin(c, product);
            if (id.startsWith("trae"))
              return claimTraeDailyCheckin(
                c,
                product,
                fetch,
                pool.traeCheckinDeviceGenerationFor(a.id),
                (g) => pool.updateTraeCheckinDeviceGeneration(a.id, g),
              );
            if (auth.claimDailyFor) return auth.claimDailyFor(c);
            if (auth.claimDailyQuota) return auth.claimDailyQuota(c);
            if (auth.claimLoginReward) return auth.claimLoginReward(c);
            throw Error("该渠道没有可用领取接口");
          }
        : undefined;
      drivers.set(id, {
        id,
        name,
        auth,
        product,
        reload,
        hydrate,
        registration,
        adapter: exposed,
        balance,
        claim,
        renew: renewAccount,
        discover,
        /**
         * 该渠道是否支持「大窗口档」（目前只有 Trae 的 Max 1M 档）。
         *
         * ⚠️ **能力与开关分开**：`supported` 只看适配器有没有这个档位概念，
         * `enabled` 是用户此刻的选择。把两者合成一个布尔会让界面无法回答
         * 「为什么我看不到 1M」——是模型不支持，还是我没开。
         */
        extendedContext: {
          supported: id === "trae",
          enabled: () => product.maxMode === true,
          /**
           * 切换大窗口档。
           *
           * ⚠️ 只改 `product.maxMode` 就够：适配器在每次 `resolveModel` /
           * `stream` 时现读 `this.product.maxMode`（见 `TraeAdapter.maxModeFor`），
           * 且 `options.product` 与这里持有的是**同一个对象**。故不需要重建
           * 适配器 —— 重建会顺带丢掉远端目录缓存。
           */
          set: async (enabled) => {
            if (id !== "trae") throw Error("该渠道没有大窗口档");
            product.maxMode = enabled === true;
            await store.call("set", "extended-context:" + id, enabled === true);
            ctx.emit("llm/adapters-updated");
          },
        },
        // 停止时落盘签名缓存（`undefined` 的渠道直接跳过）。
        flush: sigStore === undefined ? undefined : () => sigStore.flush(),
      });
    } catch (e) {
      drivers.set(id, { id, name, error: redact(e) });
      ctx.logger.warn(name + " 初始化失败：" + redact(e));
    }
  }

  async function login(provider, input = {}) {
    const driver = drivers.get(provider);
    if (!driver?.auth) throw Error(driver?.error ?? "未知渠道");
    const { auth, product } = driver;
    const accountId = provider + "-" + randomUUID();
    const refName = "ACCOUNT_" + accountId.replace(/[^A-Za-z0-9_]/g, "_");
    const opts = { refName, accountId, pool, openBrowser: async () => {} };
    let flow;
    let wechat = false;
    if (provider === "buddy" || provider === "workbuddy") {
      const state = await fetchAuthState(fetch, undefined, product);
      flow = {
        loginUrl: decorateLoginUrl(state.authUrl, product),
        result: auth.login({ ...opts, state: state.state }),
        close: async () => {},
      };
    } else if (provider === "loomy") {
      // 微信扫码是 Loomy 的首选登录方式；短信只在用户明确选择时使用。
      // 扫码页由 vendor 在 127.0.0.1 上临时起服务，host 只负责打开它。
      if (input.mode === "wechat") {
        flow = await auth.startWechatLogin();
        wechat = true;
      } else {
        // 手机号形态与上游 Loomy 备用路径一致（`channel-pack-rpc.ts` 的
        // `login.sendSms`）。放宽只会把一次注定失败的请求推到远端，用户拿到的
        // 是上游的笼统报错；这里先给出可操作的提示。
        if (
          typeof input.phone !== "string" ||
          !/^1[3-9]\d{9}$/.test(input.phone.trim())
        )
          throw Error("请输入 11 位手机号，或改用微信扫码登录");
        const phone = input.phone.trim();
        if (!input.code) {
          if (input.msgid) throw Error("验证码已过期，请重新获取");
          const msgid = await auth.sendSmsCode(phone);
          return { sms: true, msgid, phone };
        }
        if (typeof input.msgid !== "string" || !input.msgid)
          throw Error("验证码请求已失效，请重新获取");
        const value = await auth.loginWithSmsCode(
          phone,
          input.code,
          input.msgid,
          opts,
        );
        if (!pool.findAccount(accountId)) {
          const c = await readByRef(refName);
          await pool.addAccount({
            id: accountId,
            provider,
            nickname: c?.nickname ?? phone,
            credentialRef: refName,
            enabled: true,
            createdAt: Date.now(),
            expiresAt: value.expires || expires(c),
            refreshable: value.refreshable === true,
          });
        }
        await driver.reload();
        return { done: true };
      }
    } else flow = await auth.startLogin(opts);
    const token = randomUUID();
    const state = { status: "pending", provider, accountId, close: flow.close };
    pending.set(token, state);
    state.completion = flow.result
      .then(async (value) => {
        if (wechat)
          value = await auth.persistWechatLogin(value, { refName });
        if (["gemini", "raccoon"].includes(provider))
          await auth.persistLogin(value, { refName });
        if (!pool.findAccount(accountId)) {
          const c = await readByRef(refName);
          await pool.addAccount({
            id: accountId,
            provider,
            nickname:
              c?.nickname ?? c?.email ?? c?.phone ?? input.phone ?? accountId,
            credentialRef: refName,
            enabled: true,
            createdAt: Date.now(),
            expiresAt: value?.expires || expires(c),
            refreshable:
              typeof value?.refreshable === "boolean"
                ? value.refreshable
                : Boolean(c?.refresh_token),
          });
        }
        await driver.reload();
        state.status = "success";
      })
      .catch((e) => {
        state.status = "failed";
        state.error = redact(e);
      })
      .finally(() => setTimeout(() => pending.delete(token), 600000).unref());
    return {
      token,
      ...(await authorizationLink(flow.loginUrl)),
      ...(flow.userCode ? { userCode: flow.userCode } : {}),
    };
  }
  return {
    selection,
    pool,
    drivers,
    login,
    pending,
    loginsIdle: () => ![...pending.values()].some((p) => p.status === "pending"),
    async waitForLogins() {
      while ([...pending.values()].some((p) => p.status === "pending"))
        await Promise.allSettled([...pending.values()].filter((p) => p.status === "pending").map((p) => p.completion));
    },
    read,
    /**
     * 恢复持久化的渠道级设置（目前只有 Trae 的大窗口档开关）。
     *
     * ⚠️ **必须在 `hydrate()` 之前完成**：`resolveModel` 的档位与 `visible()`
     * 的名字后缀都读 `product.maxMode`，晚一步会让首屏按默认值渲染一遍
     * （用户会看到名字里没有 `1M`、随后才跳变）。
     *
     * 读不到键时保持产品默认（`DSH_TRAE_MAX_MODE` 环境变量，缺省关闭）——
     * 不把「没有记录」当成「用户关掉了」，否则环境变量会被静默覆盖。
     */
    async restore() {
      const saved = await store.call("get", "extended-context:trae");
      if (typeof saved === "boolean") {
        const driver = drivers.get("trae");
        if (driver?.product) driver.product.maxMode = saved;
      }
    },
    async hydrate() {
      for (const d of drivers.values()) await d.hydrate?.();
    },
    async stop() {
      for (const p of pending.values()) await p.close?.();
      for (const d of drivers.values()) {
        d.auth?.stop?.();
        if (typeof d.registration === "function") await d.registration();
      }
      // 签名缓存是**纯缓存**：落盘失败不该阻断插件停止（`flush` 内部已兜底）。
      for (const d of drivers.values()) {
        try {
          await d.flush?.();
        } catch {
          /* 纯缓存，失败不影响停止 */
        }
      }
    },
  };
}

