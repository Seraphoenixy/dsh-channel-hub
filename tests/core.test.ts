import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerDatabase } from "../src/storage/database.ts";
import { CatalogService } from "../src/core/catalog.ts";
import { RenewalService } from "../src/core/renewal.ts";
import { Observer } from "../src/core/observer.ts";
import { measure, present, empty, add } from "../src/core/metrics.ts";
import { rateLabel, promotionNote, promotionWindow } from "../src/core/rate.ts";
import { promotionsFromConfig } from "../src/core/promotion.ts";
import {
  dayOf,
  redact,
  type RequestRow,
  type Attempt,
} from "../src/core/types.ts";
const request = (id = "r", started = Date.now()): RequestRow => ({
  id,
  started,
  provider: "qodercn",
  model: "dfmodel",
  outcome: "success",
  ended: started + 1500,
});
const attempt = (req: RequestRow, id = "a", accountId = "one"): Attempt => ({
  id,
  requestId: req.id,
  provider: req.provider,
  model: req.model,
  accountId,
  started: req.started,
  ended: req.started + 1500,
  first: req.started + 500,
  outcome: "success",
  usage: {
    input: 100,
    output: 100,
    reasoning: 40,
    cacheRead: 50,
    cacheWrite: 0,
  },
});
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "chub-"));
  let db = new LedgerDatabase(join(dir, "ledger.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = new LedgerDatabase(join(dir, "ledger.sqlite"));
    },
  };
}
test("one logical request, two physical attempts and exact accounts", (t) => {
  const { db } = fixture(t);
  const r = request();
  db.begin({ ...r, outcome: "running" });
  const first = {
    ...attempt(r, "a", "one"),
    outcome: "failed" as const,
    error: "429",
  };
  db.finish(r, [first, attempt(r, "b", "two")]);
  const stats = db.stats();
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.attempts, 2);
  assert.equal(stats.totals.attemptFailures, 1);
  assert.equal(stats.totals.totalTokens, 500);
  assert.equal(stats.accounts.length, 2);
  assert.equal(stats.totals.successRate, 1);
});
test("finish idempotence and permanent totals after detail retention", (t) => {
  const { db } = fixture(t);
  const r = request("old", Date.now() - 100 * 86400000);
  db.begin({ ...r, outcome: "running" });
  db.finish(r, [attempt(r)]);
  db.finish(r, [attempt(r)]);
  assert.equal(db.stats().totals.requests, 1);
  db.prune();
  assert.equal(db.list().total, 0);
  assert.equal(db.stats().totals.requests, 1);
});
test("restart persists details and aggregates", (t) => {
  const f = fixture(t);
  const r = request();
  f.db.begin({ ...r, outcome: "running" });
  f.db.finish(r, [attempt(r)]);
  f.reopen();
  assert.equal(f.db.list().total, 1);
  assert.equal(f.db.stats().totals.totalTokens, 250);
});
test("crash recovery marks outstanding request interrupted once", (t) => {
  const f = fixture(t);
  const r = request();
  f.db.begin({ ...r, outcome: "running" });
  f.db.attempt({ ...attempt(r), outcome: "running" });
  f.reopen();
  assert.equal(f.db.detail("r").request.outcome, "interrupted");
  assert.equal(f.db.stats().totals.interrupted, 1);
  f.reopen();
  assert.equal(f.db.stats().totals.requests, 1);
});
test("unknown usage remains unknown; reasoning is not double counted", () => {
  const r = request();
  const a = attempt(r);
  assert.equal(present(measure(r, [a])).totalTokens, 250);
  assert.equal(present(measure(r, [{ ...a, usage: undefined }])).reported, 0);
  assert.equal(present(measure(r, [{ ...a, usage: undefined }])).avgTps, null);
});
test("missing cache counters excluded from cache denominator", () => {
  const r = request();
  const a = attempt(r);
  const b = { ...a, id: "b", usage: { input: 1000, output: 20 } };
  const m = present(measure(r, [a, b]));
  assert.equal(m.cacheHitRate, 1 / 3);
  assert.equal(m.cacheCoverage, 0.5);
});
test("success rate excludes cancellation and interruption", () => {
  const r = request();
  let m = empty();
  for (const outcome of [
    "success",
    "failed",
    "cancelled",
    "interrupted",
  ] as const)
    m = add(m, measure({ ...r, outcome }, []));
  assert.equal(present(m).successRate, 0.5);
});
test("UTC+8 midnight boundary is stable", () => {
  assert.equal(dayOf(Date.parse("2026-10-20T15:59:59Z")), "2026-10-20");
  assert.equal(dayOf(Date.parse("2026-10-20T16:00:00Z")), "2026-10-21");
});
test("catalog deduplicates requests, zero rate survives, refresh failure preserves snapshot", async () => {
  const values = new Map();
  const store = {
    async call(method: string, key: string, v?: unknown) {
      if (method === "set") values.set(key, v);
      return values.get(key);
    },
  };
  const c = new CatalogService(store);
  let resolve: any;
  let calls = 0;
  const loader = () => {
    calls++;
    return new Promise<any[]>((r) => (resolve = r));
  };
  const a = c.refresh("p:a", loader);
  const b = c.refresh("p:a", loader);
  await new Promise((r) => setTimeout(r, 0));
  resolve([{ id: "free", name: "Free", priceFactor: 0 }]);
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  const failed = await c.refresh("p:a", async () => {
    throw Error("offline");
  });
  assert.equal(failed.stale, true);
  assert.equal(failed.models[0].priceFactor, 0);
  const restarted = new CatalogService(store);
  assert.equal((await restarted.load("p:a")).models.length, 1);
});
test("successful empty directory removes vanished models", async () => {
  const values = new Map();
  const c = new CatalogService({
    async call(m: string, k: string, v?: unknown) {
      if (m === "set") values.set(k, v);
      return values.get(k);
    },
  });
  await c.refresh("x", async () => [{ id: "old", name: "Old" }]);
  assert.equal((await c.refresh("x", async () => [])).models.length, 0);
});
test("renewal single-flight and unknown expiry are not guessed", async () => {
  const a = {
    id: "one",
    provider: "qoder",
    nickname: "x",
    enabled: true,
    credentialRef: "ref",
    refreshable: true,
    expiresAt: Date.now() + 1000,
  };
  let calls = 0;
  let done: any;
  const renewal = new RenewalService(
    async () => [a, { ...a, id: "unknown", expiresAt: undefined }],
    async () => {
      calls++;
      await new Promise<void>((r) => (done = r));
    },
  );
  const first = renewal.tick();
  const second = renewal.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  done();
  await Promise.all([first, second]);
});
test("renewal failure backs off without discarding account", async () => {
  let calls = 0;
  const a = {
    id: "one",
    provider: "qoder",
    nickname: "x",
    enabled: true,
    credentialRef: "ref",
    refreshable: true,
    expiresAt: 1,
  };
  const renewal = new RenewalService(
    async () => [a],
    async () => {
      calls++;
      throw Error("offline");
    },
  );
  await renewal.tick();
  await renewal.tick();
  assert.equal(calls, 1);
  assert.match(renewal.status("one").error!, /offline/);
});
test("idle wait drains inference without aborting; shutdown still cancels", async () => {
  const o = new Observer({ async call() {} } as any, { warn() {} });
  let resume!: () => void;
  let upstreamSignal!: AbortSignal;
  const gate = new Promise<void>((r) => { resume = r; });
  async function* upstream(signal?: AbortSignal) {
    upstreamSignal = signal!;
    yield { type: "text-delta", text: "first" };
    await gate;
    yield { type: "text-delta", text: "last" };
  }
  const iterator = o.stream("trae", "model", upstream);
  await iterator.next();
  const next = iterator.next();
  let idle = false;
  const waiting = o.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  assert.equal(upstreamSignal.aborted, false);
  resume();
  assert.equal((await next).value.text, "last");
  await iterator.next();
  await waiting;
  assert.equal(o.isIdle(), true);
  assert.equal(upstreamSignal.aborted, false);

  const second = o.stream("trae", "model", upstream);
  await second.next();
  const closing = o.close();
  assert.equal(upstreamSignal.aborted, true);
  await second.return(undefined);
  await closing;
});

test("redaction removes token fields and bearer", () => {
  const text = redact(
    "access_token=secret refreshToken: other Authorization: Bearer xyz",
  );
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("other"));
  assert.ok(!text.includes("xyz"));
});
test("physical attempts and concurrent request accounts stay isolated", async (t) => {
  const { db } = fixture(t);
  const store = {
    async call(method: string, ...args: any[]) {
      return (db as any)[method](...args);
    },
  };
  const o = new Observer(store, { warn() {} });
  let calls = 0;
  const fetcher = o.fetcher(async () => {
    calls++;
    return new Response("ok");
  });
  async function* run(account: string) {
    o.bindAccount(account);
    const response = await fetcher("https://example.test/chat/completions", {
      method: "POST",
    });
    await response.text();
    yield { type: "text-delta", text: "hello" };
    yield {
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
  await Promise.all(
    ["one", "two"].map(async (account) => {
      for await (const _ of o.stream("qoder", "m", () => run(account))) {
      }
    }),
  );
  assert.equal(calls, 2);
  const records = db.list().items;
  assert.equal(records.length, 2);
  assert.deepEqual(
    new Set(records.flatMap((r) => r.attempts.map((a) => a.accountId))),
    new Set(["one", "two"]),
  );
  assert.equal(db.stats().totals.totalTokens, 6);
});
test("each transport retry is logged, while final request counts once", async (t) => {
  const { db } = fixture(t);
  const o = new Observer(
    {
      async call(m: string, ...a: any[]) {
        return (db as any)[m](...a);
      },
    },
    { warn() {} },
  );
  let n = 0;
  const f = o.fetcher(
    async () => new Response("x", { status: ++n === 1 ? 429 : 200 }),
  );
  async function* run() {
    o.bindAccount("one");
    let r = await f("https://example.test/chat/completions", {
      method: "POST",
    });
    await r.text();
    o.bindAccount("two");
    r = await f("https://example.test/chat/completions", { method: "POST" });
    await r.text();
    yield { type: "text-delta", text: "x" };
  }
  for await (const _ of o.stream("qoder", "m", run)) {
  }
  assert.equal(db.stats().totals.requests, 1);
  assert.equal(db.stats().totals.attempts, 2);
  assert.equal(db.stats().totals.attemptFailures, 1);
});
test("storage failure does not change generated result and reports health", async () => {
  const o = new Observer(
    {
      async call() {
        throw Error("disk full");
      },
    },
    { warn() {} },
  );
  async function* run() {
    yield { type: "text-delta", text: "kept" };
  }
  const out = [];
  for await (const c of o.stream("p", "m", run)) out.push(c.text);
  assert.deepEqual(out, ["kept"]);
  assert.equal(o.health.failedWrites, 2);
});

test("second writer cannot recover another live instance requests", (t) => {
  const f = fixture(t);
  const req = request();
  f.db.begin({ ...req, outcome: "running" });
  assert.throws(
    () => new LedgerDatabase(join(f.dir, "ledger.sqlite")),
    /另一实例/,
  );
  assert.equal(f.db.detail(req.id).request.outcome, "running");
});
test("stream finish-error is a failed logical request even without throwing", async (t) => {
  const { db } = fixture(t);
  const o = new Observer(
    {
      async call(method: string, ...args: any[]) {
        return (db as any)[method](...args);
      },
    },
    { warn() {} },
  );
  async function* run() {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: "quota" } },
    };
  }
  for await (const _ of o.stream("p", "m", run)) {
  }
  assert.equal(db.list().items[0].outcome, "failed");
  assert.equal(db.stats().totals.failed, 1);
});
test("SSE business-error retry preserves reported usage from failed attempt", async (t) => {
  const { db } = fixture(t);
  const o = new Observer(
    {
      async call(method: string, ...args: any[]) {
        return (db as any)[method](...args);
      },
    },
    { warn() {} },
  );
  let n = 0;
  const f = o.fetcher(
    async () =>
      new Response(
        ++n === 1
          ? 'data: {"error":{"message":"quota"},"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n'
          : 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      ),
  );
  async function* run() {
    o.bindAccount("a");
    await (await f("https://test/chat/completions", { method: "POST" })).text();
    o.bindAccount("b");
    await (await f("https://test/chat/completions", { method: "POST" })).text();
    yield { type: "text-delta", text: "done" };
  }
  for await (const _ of o.stream("p", "m", run)) {
  }
  const stats = db.stats().totals;
  assert.equal(stats.attemptFailures, 1);
  assert.equal(stats.totalTokens, 10);
});

test("expiry honors Gemini RFC3339 and numeric token timestamps without guessed TTL", async () => {
  const { credentialExpiry } = await import("../src/core/types.ts");
  assert.equal(
    credentialExpiry({ expiry: "2026-10-20T00:00:00Z" }),
    Date.parse("2026-10-20T00:00:00Z"),
  );
  assert.equal(
    credentialExpiry({ expires_at: "1790000000000" }),
    1790000000000,
  );
  assert.equal(credentialExpiry({ expire_time: 1790000000 }), 1790000000000);
  assert.equal(credentialExpiry({ expires_in: 3600 }), undefined);
});

test("partial usage frames preserve previously reported input tokens", async (t) => {
  const { db } = fixture(t);
  const o = new Observer(
    {
      async call(method: string, ...args: any[]) {
        return (db as any)[method](...args);
      },
    },
    { warn() {} },
  );
  const f = o.fetcher(
    async () => new Response('data: {"usage":{"input_tokens":10}}\n\n'),
  );
  async function* run() {
    o.bindAccount("a");
    await (await f("https://test/messages", { method: "POST" })).text();
    yield { type: "usage", usage: { outputTokens: 2 } };
  }
  for await (const _ of o.stream("p", "m", run)) {
  }
  assert.equal(db.stats().totals.totalTokens, 12);
});

test("rate labels cover Qoder, Buddy and Trae without inventing values", () => {
  assert.equal(rateLabel({ priceFactor: 0 }), "0×");
  assert.equal(rateLabel({ priceFactor: 0.5 }), "0.5×");
  assert.equal(rateLabel({ creditsRate: "x0.29" }), "x0.29");
  assert.equal(
    rateLabel({ creditsRate: "x0.17", discountedCreditsRate: "x0.50" }),
    "x0.17→x0.50",
  );
  assert.equal(
    rateLabel({ creditsRate: "x0.00", discountedCreditsRate: "免费" }),
    "x0.00→免费",
  );
  assert.equal(rateLabel({ creditsRate: 0.78 }), "x0.78");
  assert.equal(rateLabel({ creditsRate: 0 }), "免费");
  assert.equal(
    rateLabel({ creditsRate: 0.08, originalCreditsRate: 0.8 }),
    "x0.8→x0.08",
  );
  assert.equal(
    rateLabel({ creditsRate: 0, originalCreditsRate: 0.1 }),
    "x0.1→免费",
  );
  assert.equal(rateLabel({}), undefined);
  assert.equal(rateLabel({ creditsRate: "" }), undefined);
  assert.equal(rateLabel({ priceFactor: Number.NaN }), undefined);
});

test("promotion notes describe the window while rates stay as the catalog states them", () => {
  const night = {
    creditsRate: "x0.29",
    discountedCreditsRate: "免费",
    promotion: {
      daily: [{ start: "23:00", end: "7:50" }],
      timezone: "Asia/Shanghai",
      label: "夜间折扣",
      rate: "免费",
    },
  };
  // 倍率不按窗口推算：白天夜里都是同一个值，不随读取时刻跳变。
  assert.equal(rateLabel(night, new Date("2026-10-20T15:00:00Z")), "x0.29→免费");
  assert.equal(rateLabel(night, new Date("2026-10-20T04:00:00Z")), "x0.29→免费");
  // 活动标签才是「什么时候生效」的载体，白天也要看得到。
  assert.equal(promotionNote(night), "夜间折扣 23:00–07:50");
  assert.equal(promotionWindow(night), "23:00–07:50");

  // 实机形态：白天抓目录时 OFM 已把折后价丢掉（无 discountedCreditsRate），
  // 只剩本插件补的 promotion —— 折扣仍要从 promotion.rate 取到。
  const onlyPromotion = {
    creditsRate: "x0.29",
    promotion: {
      daily: [{ start: "23:00", end: "08:00" }],
      timezone: "Asia/Shanghai",
      label: "夜间免费",
      rate: "免费",
    },
  };
  assert.equal(rateLabel(onlyPromotion), "x0.29→免费");
  assert.equal(promotionNote(onlyPromotion), "夜间免费 23:00–08:00");
  assert.equal(promotionWindow(onlyPromotion), "23:00–08:00");

  // Qoder 错峰折扣：倍率就是目录声明的 price_factor，角标单独给时段语义。
  const qoder = {
    priceFactor: 0.2,
    promotion: {
      active: true,
      discountFactor: 0.4,
      beforePromotionPriceFactor: 0.5,
      windowStart: "22:00",
      windowEnd: "08:00",
      badgeZh: "错峰 4 折",
    },
  };
  assert.equal(rateLabel(qoder, new Date("2026-10-20T15:00:00Z")), "0.2×");
  assert.equal(rateLabel(qoder, new Date("2026-10-20T04:00:00Z")), "0.2×");
  assert.equal(promotionNote(qoder), "错峰 4 折");

  // 没有角标时用时段兜底，仍然给出「什么时候」。
  assert.equal(
    promotionNote({
      creditsRate: "x0.79",
      promotion: {
        daily: [{ start: "23:00", end: "7:50" }],
        timezone: "Asia/Shanghai",
        rate: "x0.50",
      },
    }),
    "23:00–07:50",
  );

  // 有效期已过的活动不再提示（标签与时段都不再出现）。
  assert.equal(
    promotionNote({
      promotion: { rate: "免费", validUntil: "2026-10-01T00:00:00Z" },
    }),
    undefined,
  );
  assert.equal(
    promotionWindow({
      promotion: { rate: "免费", validUntil: "2026-10-01T00:00:00Z" },
    }),
    undefined,
  );

  // Trae 只有活动终点，没有每日时段；按本地时间展示到分钟。
  const endsAt = new Date("2026-10-25T10:30:00Z");
  const stamp =
    String(endsAt.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(endsAt.getDate()).padStart(2, "0") +
    " " +
    String(endsAt.getHours()).padStart(2, "0") +
    ":" +
    String(endsAt.getMinutes()).padStart(2, "0");
  assert.equal(
    promotionNote(
      { discountEndsAtSec: Math.floor(endsAt.getTime() / 1000) },
      new Date("2026-10-20T00:00:00Z"),
    ),
    "限时折扣至 " + stamp,
  );
  // 活动已结束就不再提示。
  assert.equal(
    promotionNote(
      { discountEndsAtSec: Math.floor(endsAt.getTime() / 1000) },
      new Date("2026-10-26T00:00:00Z"),
    ),
    undefined,
  );
});

test("promotion parser keeps windowed free offers and drops ended placeholders", () => {  const config = {
    data: {
      modelPromotions: [
        {
          enabled: true,
          priority: 100,
          discount: { discountedCredits: "0.50x", factor: 0.5 },
          badge: { label: "夜间折扣" },
          schedule: {
            daily: [{ start: "23:00", end: "7:50" }],
            timezone: "Asia/Shanghai",
          },
          modelIds: ["glm-5.2"],
        },
        {
          enabled: true,
          discount: { discountedCredits: "0x", factor: 0 },
          schedule: {
            daily: [{ start: "23:00", end: "7:50" }],
            timezone: "Asia/Shanghai",
          },
          modelIds: ["hy4-preview"],
        },
        // 无窗口的 0x 是遗留占位，不是免费。
        { enabled: true, discount: { discountedCredits: "0x", factor: 0 }, modelIds: ["ghost"] },
        // 已停用。
        { enabled: false, discount: { discountedCredits: "0.1x", factor: 0.1 }, modelIds: ["off"] },
        // 只有有效期（限时免费）。
        {
          enabled: true,
          discount: { discountedCredits: "0x", factor: 0 },
          schedule: { validUntil: "2026-10-21T00:00:00Z" },
          modelIds: ["hy3"],
        },
      ],
    },
  };
  const map = promotionsFromConfig(config);
  assert.deepEqual(map.get("glm-5.2"), {
    daily: [{ start: "23:00", end: "7:50" }],
    timezone: "Asia/Shanghai",
    label: "夜间折扣",
    rate: "x0.50",
  });
  assert.equal(map.get("hy4-preview")?.rate, "免费");
  assert.equal(map.has("ghost"), false);
  assert.equal(map.has("off"), false);
  assert.equal(map.get("hy3")?.validUntil, "2026-10-21T00:00:00Z");
  assert.equal(promotionsFromConfig({}).size, 0);
  assert.equal(promotionsFromConfig(null).size, 0);
});
