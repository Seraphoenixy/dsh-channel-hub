import test from "node:test";
import assert from "node:assert/strict";
import {
  CodeArtsCatalogAuthError,
  SNAP_MODEL_BUILTIN_URL,
  isCodeArtsAuthFailure,
  fetchCodeArtsRemoteModels,
} from "../vendor/ofm/src/models.ts";
import { CodeArtsAuth } from "../vendor/ofm/src/service.ts";
import {
  STS_TOKEN_ENDPOINT,
  generateDpopKeyPair,
} from "../vendor/ofm/src/oauth.ts";

/**
 * 回归锁（2026-10-29，用户报障「目录 HTTP 400：code APIG.0602：Bad
 * request: the security token has expired」）：
 *
 * 目录拉取路径此前没有接聊天路径早已有的「鉴权失败 → 静默续期 → 重试」
 * 自愈 —— `firstUsableCredential` 只看 AK/SK 存在、不看 expires_at，
 * 过期凭据照样签名发出；APIG.0602 被当成普通失败吞掉，目录变空列表。
 * 这里用夹具钉死修复后的完整链路。
 *
 * 与真实网络验收的分工（AGENTS.md）：夹具不联网、不读真实账号，只锁
 * 协议编排；真实凭据验收单独记载于 docs/ACCEPTANCE.md。
 */

/* ───────────── 判据本体：HTTP 400 形态的 APIG.0602 必须命中 ───────────── */

test("isCodeArtsAuthFailure matches the user-reported APIG.0602 with HTTP 400", () => {
  // 用户报障原文的形态：状态码是 400（不是聊天路径的 401/403），
  // 判据只看状态码就会漏 —— 必须同时看响应体。
  assert.equal(
    isCodeArtsAuthFailure(
      400,
      '{"error_code":"APIG.0602","error_msg":"Bad request: the security token has expired"}',
    ),
    true,
  );
  // 聊天路径实测过的 401 / 403（含空体 403）。
  assert.equal(isCodeArtsAuthFailure(401, ""), true);
  assert.equal(isCodeArtsAuthFailure(403, ""), true);
  assert.equal(isCodeArtsAuthFailure(401, '{"error_code":"APIG.0301"}'), true);
  // 响应体文案命中：英文变体（网关偶发的非 JSON 报文）。
  // 注：用户报障原文「the security token has expired」实际总是伴随
  // error_code APIG.0602 出现（上面第一条即其完整形态），判据靠码命中；
  // 这里锁的是聊天路径沿用多年的两个文案形态。
  assert.equal(isCodeArtsAuthFailure(200, "token expired"), true);
  assert.equal(isCodeArtsAuthFailure(502, "APIG.0602 invalid token"), true);
  // 非鉴权失败不得误伤：普通 5xx / 404 / 网关 4000（通道下线）。
  assert.equal(isCodeArtsAuthFailure(500, "internal error"), false);
  assert.equal(
    isCodeArtsAuthFailure(
      200,
      '{"error_code":"4000","error_msg":"invalid channel, group not found"}',
    ),
    false,
  );
  assert.equal(isCodeArtsAuthFailure(404, "not found"), false);
});

/* ───────────── fetchCodeArtsRemoteModels：鉴权失败上抛、其余仍容忍 ───────────── */

const VALID_CATALOG = JSON.stringify({
  count: 1,
  builtinModels: [{ model_id: "glm-5.3", model_name: "GLM-5.3" }],
});

function authFailureResponse() {
  return new Response(
    '{"error_code":"APIG.0602","error_msg":"Bad request: the security token has expired"}',
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

test("fetchCodeArtsRemoteModels surfaces APIG.0602 instead of swallowing it", async () => {
  await assert.rejects(
    fetchCodeArtsRemoteModels(
      {
        access_key_id: "synthetic-ak",
        secret_access_key: "synthetic-sk",
        security_token: "expired-st",
      },
      async () => authFailureResponse(),
    ),
    (error) => {
      assert.ok(error instanceof CodeArtsCatalogAuthError);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /APIG\.0602/);
      return true;
    },
  );
});

test("fetchCodeArtsRemoteModels still tolerates non-auth upstream failures", async () => {
  // 普通 5xx / 4000（通道下线形态）维持既有容错语义：返回空列表，不抛。
  for (const [status, body] of [
    [500, "internal error"],
    [200, '{"error_code":"4000","error_msg":"invalid channel, group not found"}'],
    [503, ""],
  ]) {
    const models = await fetchCodeArtsRemoteModels(
      {
        access_key_id: "synthetic-ak",
        secret_access_key: "synthetic-sk",
        security_token: "synthetic-st",
      },
      async () =>
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    assert.deepEqual(models, [], `status ${status} must stay tolerated`);
  }
});

/* ───────────── refreshModels：完整自愈编排（续期 → 重试 → 成功） ───────────── */

/**
 * 最小 cordis 替身：`Service` 基类只用到 `ctx`（`ctx.credentials.resolve`
 * / `ctx.credentials.set` / `ctx.logger`），`ctx.reflect.provide` 与真实
 * 宿主无涉 —— `verify-host.mjs` 才覆盖宿主接线，夹具不重复宿主断言。
 */
function fakeContext(store, logger) {
  return {
    credentials: {
      resolve: async (ref) => {
        const value = store.get(ref);
        return value === undefined ? undefined : { value };
      },
      set: async (ref, value) => {
        store.set(ref, value);
      },
    },
    logger,
    // cordis `Service` 基类构造时需要 `ctx.reflect.provide(name, …)`；
    // 夹具只用到 credentials / logger，反射注册 no-op 即可（真实接线由
    // verify-host 覆盖）。
    reflect: { provide: () => {} },
  };
}

function fakePool(entries) {
  return {
    listAccountsByProvider: (provider) =>
      provider === "codearts" ? entries : [],
    updateAccount: async () => {},
    findAccountIdByCredential: async () => "",
  };
}

/** 一份「材料齐全、但 SecurityToken 已过期」的凭据（DPoP 私钥本地生成）。 */
const EXPIRED_AT = "2026-10-29T04:00:00Z";
const REFRESHED_AT = new Date(Date.now() + 6 * 3600_000).toISOString();
const DPOP_JWK = (await generateDpopKeyPair()).privateKeyJwk;

function expiredCredential() {
  return {
    access_key_id: "ak-old",
    secret_access_key: "sk-old",
    security_token: "st-old",
    expires_at: EXPIRED_AT,
    refresh_token: "rt-old",
    code_verifier: "cv-old",
    dpop_private_key_jwk: DPOP_JWK,
  };
}

test("refreshModels renews the expired credential before fetching (entry precheck)", async () => {
  const logs = [];
  const store = new Map();
  const entry = { id: "acct-1", credentialRef: "CODEARTS_ACCOUNT_1" };
  store.set(entry.credentialRef, JSON.stringify(expiredCredential()));
  const auth = new CodeArtsAuth(fakeContext(store, {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  }), { fetcher: syntheticJourney });
  const fetchedWith = [];

  // 旅程：目录端点直接 200 成功；续期端点返回新凭据。
  async function syntheticJourney(url) {
    if (String(url) === STS_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          credentials: {
            access_key_id: "ak-new",
            secret_access_key: "sk-new",
            security_token: "st-new",
            expiration: REFRESHED_AT,
          },
          refresh_token: "rt-new",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(String(url), SNAP_MODEL_BUILTIN_URL, "only builtin is requested");
    fetchedWith.push("st-new"); // 抓不到签名的 token 本体，用“到达目录端点”计数
    return new Response(VALID_CATALOG, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const models = await auth.refreshModels(fakePool([entry]));
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "glm-5.3");
  // 续期确实发生过：存储里已是新凭据。
  const saved = JSON.parse(store.get(entry.credentialRef));
  assert.equal(saved.access_key_id, "ak-new");
  assert.equal(saved.refresh_token, "rt-new");
  assert.equal(saved.security_token, "st-new");
  // 目录请求只发了一次，且发生在续期之后（凭据未过期时预判分支不会先刷）。
  assert.equal(fetchedWith.length, 1);
});

test("refreshModels retries once through silent renewal after APIG.0602", async () => {
  const logs = [];
  const store = new Map();
  const entry = { id: "acct-1", credentialRef: "CODEARTS_ACCOUNT_1" };
  // 凭据「看起来未过期」（入口预判不触发），模拟 SecurityToken 被后端
  // 提前吊销 / 时钟偏差：首次目录请求仍被网关拒绝。
  const notYetExpired = {
    ...expiredCredential(),
    expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  };
  store.set(entry.credentialRef, JSON.stringify(notYetExpired));
  const auth = new CodeArtsAuth(fakeContext(store, {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  }), { fetcher: syntheticJourney });

  let catalogCalls = 0;
  async function syntheticJourney(url) {
    if (String(url) === STS_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          credentials: {
            access_key_id: "ak-new",
            secret_access_key: "sk-new",
            security_token: "st-new",
            expiration: REFRESHED_AT,
          },
          refresh_token: "rt-new",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    catalogCalls += 1;
    if (catalogCalls === 1) return authFailureResponse();
    return new Response(VALID_CATALOG, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const models = await auth.refreshModels(fakePool([entry]));
  assert.equal(models.length, 1);
  assert.equal(catalogCalls, 2, "must retry the catalog exactly once after renewal");
  assert.ok(logs.some((m) => m.includes("静默续期")), "renewal attempt must be logged");
  const saved = JSON.parse(store.get(entry.credentialRef));
  assert.equal(saved.security_token, "st-new");
});

test("refreshModels keeps retry failure loud: second APIG.0602 surfaces with upstream code", async () => {
  const store = new Map();
  const entry = { id: "acct-1", credentialRef: "CODEARTS_ACCOUNT_1" };
  const notYetExpired = {
    ...expiredCredential(),
    expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  };
  store.set(entry.credentialRef, JSON.stringify(notYetExpired));
  const auth = new CodeArtsAuth(fakeContext(store, {
    info: () => {},
    warn: () => {},
  }), { fetcher: syntheticJourney });

  let tokenCalls = 0;
  async function syntheticJourney(url) {
    if (String(url) === STS_TOKEN_ENDPOINT) {
      tokenCalls += 1;
      return new Response(
        JSON.stringify({
          credentials: {
            access_key_id: "ak-new",
            secret_access_key: "sk-new",
            security_token: "st-new",
            expiration: REFRESHED_AT,
          },
          refresh_token: `rt-new-${tokenCalls}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // 目录端点恒拒（refresh_token 被吊销 / 账号侧真失效）。
    return authFailureResponse();
  }

  await assert.rejects(
    auth.refreshModels(fakePool([entry])),
    (error) => {
      assert.ok(error instanceof CodeArtsCatalogAuthError);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /APIG\.0602/);
      return true;
    },
  );
  // 重试用的凭据确实是续期后的新凭据（不是拿旧凭据又打一次）。
  assert.equal(tokenCalls, 1);
  const saved = JSON.parse(store.get(entry.credentialRef));
  assert.equal(saved.security_token, "st-new");
});

test("refreshModels keeps the preexisting tolerating behavior when no account exists", async () => {
  const store = new Map();
  const auth = new CodeArtsAuth(fakeContext(store, {
    info: () => {},
    warn: () => {},
  }), { fetcher: async () => {
    throw Error("network must not be used without an account");
  } });
  assert.deepEqual(await auth.refreshModels(fakePool([])), []);
});

/* ───────────── 续期互斥：目录刷新与既有入口共用 per-ref 锁 ───────────── */

test("refreshModels reuses a credential renewed elsewhere while waiting on the lock", async () => {
  // 场景：目录刷新撞上过期凭据要续期；排队等锁期间，「他处」
  // （推理路径 / refreshAll / 另一个实例）已经把凭据续好并落盘。
  // 目录刷新的锁内重读必须复用那份新凭据，**不再发第二次续期请求** ——
  // 华为 STS 签发新凭据会作废旧 refresh_token，重复消费会把他处的成功
  // 续期顶掉（`refreshAll` 注释里的并发重放缺陷）。
  const logs = [];
  const store = new Map();
  const entry = { id: "acct-1", credentialRef: "CODEARTS_ACCOUNT_1" };
  store.set(entry.credentialRef, JSON.stringify(expiredCredential()));

  // 门控：第一次 STS 请求（来自并行的 refreshAccountCredential）挂起，
  // 等我们放行 —— 期间目录刷新在队列里等同一把 per-ref 锁。
  let releaseSts;
  const stsGate = new Promise((resolve) => {
    releaseSts = resolve;
  });
  let tokenCalls = 0;
  async function syntheticJourney(url) {
    if (String(url) === STS_TOKEN_ENDPOINT) {
      tokenCalls += 1;
      await stsGate;
      return new Response(
        JSON.stringify({
          credentials: {
            access_key_id: "ak-new",
            secret_access_key: "sk-new",
            security_token: "st-new",
            expiration: REFRESHED_AT,
          },
          refresh_token: "rt-new",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(VALID_CATALOG, {
      status: 200,
      headers: { "content-type": "application/json" } },
    );
  }
  const auth = new CodeArtsAuth(fakeContext(store, {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  }), { fetcher: syntheticJourney });

  // 「他处」先占住锁：其 STS 请求挂起在门上。
  const elsewhere = auth.refreshAccountCredential(
    entry.credentialRef,
    fakePool([entry]),
    entry.id,
  );
  // 目录刷新进场：过期凭据 → 预判续期 → 排在同一把锁后面。
  const modelsPromise = auth.refreshModels(fakePool([entry]));
  // 放行：他处续期完成并落盘；目录刷新拿到锁后重读到新凭据。
  releaseSts();
  const models = await modelsPromise;
  await elsewhere;

  assert.equal(models.length, 1);
  // 续期请求只发了一次（他处那一次）；目录刷新复用结果。
  assert.equal(tokenCalls, 1);
  assert.ok(
    logs.some((m) => m.includes("已被他处续期") || m.includes("已被他处更新")),
    "lock-reuse branch must be logged",
  );
  const saved = JSON.parse(store.get(entry.credentialRef));
  assert.equal(saved.security_token, "st-new");
});

/* ───────────── 判据口径：聊天与目录共用同一实现 ───────────── */

test("catalog and chat paths share the same auth-failure predicate", async () => {
  // llm-adapter 的 isAuthError 是私有薄封装；这里通过「同一份夹具同时
  // 驱动两条路径」锁口径一致：聊天路径对 APIG.0602(400) 也必须触发
  // 静默续期重试（此前的判据只认 401/403 + 响应体，400 且非 JSON 文案
  // 的形态由共享判据兜住）。
  const { CodeArtsAdapter } = await import("../vendor/ofm/src/llm-adapter.ts");
  let calls = 0;
  let refreshed = 0;
  const adapter = new CodeArtsAdapter({
    credentialRef: "SYNTHETIC_CODEARTS",
    resolveCredential: async () => ({
      access_key_id: "synthetic-ak",
      secret_access_key: "synthetic-sk",
      security_token: "expired-st",
      expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    }),
    refresh: async () => {
      refreshed += 1;
    },
    fetchRemoteModels: async () => [{ id: "glm-5.3", name: "GLM-5.3" }],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return authFailureResponse();
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n' +
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const text = [];
  for await (const chunk of adapter.stream({
    model: "glm-5.3",
    signal: AbortSignal.timeout(10_000),
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    if (chunk.type === "text-delta" || chunk.type === "text") text.push(chunk.text ?? "");
  }
  assert.equal(calls, 2, "chat must retry once after APIG.0602");
  assert.equal(refreshed, 1);
  assert.equal(text.join(""), "OK");
});
