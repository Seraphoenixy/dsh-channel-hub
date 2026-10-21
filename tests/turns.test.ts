/**
 * 运行日志的口径：**轮次**而不是步数，以及**流式速度 vs 整块吞吐**两个独立指标。
 *
 * 背景：DSH 的 agent loop 每「步」调一次模型，一次用户消息通常 3–5 步；
 * 而 DSH 只向适配器下发 `sessionId`，**没有 turn/step 字段**，所以轮次由
 * 「最后一条消息是不是纯用户消息」推断（见 `streamMeta`）。
 *
 * 全部使用合成数据，不联网、不读真实账号。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Observer } from "../src/core/observer.ts";
import { LedgerDatabase } from "../src/storage/database.ts";
import { measure, present } from "../src/core/metrics.ts";
import { streamMeta } from "../src/drivers/ofm.js";

const logger = { warn() {} };

test("streamMeta: 纯用户消息开启新一轮，工具结果不算", () => {
  const user = { role: "user", content: [{ type: "text", text: "hi" }] };
  const tool = { role: "tool", content: [{ type: "text", text: "ok" }] };
  // 0.1.7 之前的形态：工具结果内嵌在 user 消息里，那是同一轮的后续步。
  const embedded = {
    role: "user",
    content: [{ type: "tool-result", toolCallId: "t1", content: "ok" }],
  };
  assert.deepEqual(streamMeta({ sessionId: "s1", messages: [user] }), {
    sessionId: "s1",
    startsTurn: true,
  });
  assert.equal(streamMeta({ sessionId: "s1", messages: [user, tool] }).startsTurn, false);
  assert.equal(streamMeta({ sessionId: "s1", messages: [user, embedded] }).startsTurn, false);
  assert.equal(streamMeta({ messages: [user] }).startsTurn, true);
  assert.equal(streamMeta({ messages: [] }).startsTurn, false);
  // 没有 sessionId 时不编造。
  assert.equal(streamMeta({ messages: [user] }).sessionId, undefined);
});

/** 记录 `begin` / `finish` 的存储替身。 */
const collectingStore = () => {
  const began: any[] = [];
  const finished: any[] = [];
  const store = {
    async call<T = any>(method: string, ...args: any[]): Promise<T> {
      if (method === "begin") began.push(args[0]);
      if (method === "finish") finished.push(args[0]);
      return undefined as T;
    },
  };
  return { began, finished, store };
};

/** 跑完一次 stream（产生首字 + usage）。 */
async function runStream(observer: Observer, meta?: StreamMetaLike) {
  const chunks = (async function* () {
    yield { type: "text-delta", text: "hi" };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
  })();
  for await (const _ of observer.stream("p", "m", () => chunks, undefined, meta))
    void _;
}

interface StreamMetaLike {
  sessionId?: string;
  startsTurn?: boolean;
}

test("Observer: 同一会话的连续调用共享一个 turnId，只有 startsTurn 开新轮", async () => {
  const { began, store } = collectingStore();
  const observer = new Observer(store, logger);
  await runStream(observer, { sessionId: "s1", startsTurn: true });
  await runStream(observer, { sessionId: "s1", startsTurn: false });
  await runStream(observer, { sessionId: "s1", startsTurn: false });
  await runStream(observer, { sessionId: "s1", startsTurn: true });
  const [a, b, c, d] = began;
  assert.equal(a.turnId, a.id, "新一轮以本轮第一个请求的 id 标识");
  assert.equal(b.turnId, a.id);
  assert.equal(c.turnId, a.id);
  assert.equal(d.turnId, d.id);
  assert.notEqual(d.turnId, a.id);
  assert.equal(a.startsTurn, true);
  assert.equal(b.startsTurn, undefined);
  assert.equal(a.sessionId, "s1");
});

test("Observer: 没有会话 id 的调用各自成轮（等价于按步）", async () => {
  const { began, store } = collectingStore();
  const observer = new Observer(store, logger);
  await runStream(observer, undefined);
  await runStream(observer, undefined);
  assert.notEqual(began[0].turnId, began[1].turnId);
  assert.equal(began[0].turnId, began[0].id);
});

test("驱动同步抛错时请求仍被收尾，且不占活跃槽位", async () => {
  const { finished, store } = collectingStore();
  const observer = new Observer(store, logger);
  // 驱动在创建迭代器时同步抛错（凭据缺失 / 参数校验 / 适配器自身异常）。
  const boom = () => {
    throw Error("boom at iterator creation");
  };
  await assert.rejects(async () => {
    for await (const _ of observer.stream("p", "m", boom)) void _;
  }, /boom at iterator creation/);
  // 关键：请求必须落成 failed 并写回 finish，活跃槽位也要释放，
  // 否则关闭 / 热重载会一直等一个永远不会结束的请求。
  assert.equal(observer.isIdle(), true);
  const last = finished.at(-1);
  assert.equal(last.outcome, "failed");
  assert.match(last.error, /boom/);
  assert.ok(last.ended, "必须写入结束时刻");
});

test("运行日志按轮次分页：total 是轮数、steps 是调用数", () => {
  const db = new LedgerDatabase(":memory:");
  const row = (id: string, turnId: string, started: number) => ({
    id,
    turnId,
    provider: "p",
    model: "m",
    started,
    outcome: "running" as const,
  });
  const attempt = (id: string, requestId: string, started: number) => ({
    id,
    requestId,
    provider: "p",
    model: "m",
    accountId: "acc",
    started,
    ended: started + 1000,
    outcome: "success" as const,
    usage: { input: 1, output: 10 },
  });
  try {
    const rows: [string, string, number][] = [
      ["a", "t1", 1000],
      ["b", "t1", 3000],
      ["c", "t2", 5000],
    ];
    for (const [id, turnId, started] of rows) {
      const req = row(id, turnId, started);
      db.begin(req);
      db.finish(
        { ...req, outcome: "success" as const, ended: started + 2000 },
        [attempt("at-" + id, id, started)],
      );
    }
    const page = db.list({});
    assert.equal(page.total, 2, "两轮");
    assert.equal(page.steps, 3, "三次调用");
    assert.equal(page.items.length, 2);
    // 最新一轮在前。
    assert.equal(page.items[0].id, "t2");
    assert.equal(page.items[0].stepCount, 1);
    assert.equal(page.items[1].id, "t1");
    assert.equal(page.items[1].stepCount, 2);
    assert.equal(page.items[1].steps.length, 2);
    assert.equal(page.items[1].steps[0].id, "a");
    assert.equal(page.items[1].steps[1].id, "b");
  } finally {
    db.close();
  }
});

test("旧行没有轮次信息时各自成轮（迁移不编造轮次）", () => {
  const db = new LedgerDatabase(":memory:");
  try {
    // 直接以「没有 turnId」的形状写入，模拟 v1 库里的历史行。
    db.begin({
      id: "old-1",
      provider: "p",
      model: "m",
      started: 1000,
      outcome: "running",
    });
    db.finish(
      {
        id: "old-1",
        provider: "p",
        model: "m",
        started: 1000,
        ended: 2000,
        outcome: "success",
      },
      [
        {
          id: "at-old-1",
          requestId: "old-1",
          provider: "p",
          model: "m",
          accountId: "acc",
          started: 1000,
          ended: 2000,
          outcome: "success",
          usage: { input: 1, output: 5 },
        },
      ],
    );
    const page = db.list({});
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, "old-1");
  } finally {
    db.close();
  }
});

test("收尾时 attempt 尚未定稿（running / 无 ended）也计入速度与吞吐", () => {
  // 线上真实形态：适配器先结束迭代，HTTP body 还没读到 EOF，fetcher 尚未补写
  // `ended` / `outcome`。此时若只看 `final.ended`，样本会被系统性丢成 0。
  const req = {
    id: "r",
    provider: "p",
    model: "m",
    started: 0,
    ended: 10_000,
    outcome: "success" as const,
  };
  const unfinished = {
    id: "a",
    requestId: "r",
    provider: "p",
    model: "m",
    accountId: "acc",
    started: 1000,
    outcome: "running" as const,
    first: 5_000,
    usage: { input: 1, output: 100 },
  };
  const m = present(measure(req, [unfinished] as any));
  assert.equal(m.speedSamples, 1);
  assert.equal(m.avgTps, 20); // 100 / (请求结束 10s − 首字 5s)
  assert.equal(m.throughputSamples, 1);
  assert.equal(m.avgThroughput, 10); // 100 / 10s
});

test("整块吞吐与流式速度分开统计，绝不混进同一个平均", () => {
  const req = {
    id: "r",
    provider: "p",
    model: "m",
    started: 0,
    ended: 10_000,
    outcome: "success" as const,
  };
  const withoutFirst = {
    id: "a",
    requestId: "r",
    provider: "p",
    model: "m",
    accountId: "",
    started: 0,
    ended: 1000,
    outcome: "success" as const,
    usage: { input: 1, output: 100 },
  };
  // 没观测到首字（整块返回）：流式速度不可知，但整块吞吐可得。
  const bulk = present(measure(req, [withoutFirst] as any));
  assert.equal(bulk.avgTps, null);
  assert.equal(bulk.avgThroughput, 10); // 100 token / 10 秒

  // 观测到首字（第 500ms）：两个口径各按各的分母。
  const streamed = present(
    measure(req, [{ ...withoutFirst, first: 500 }] as any),
  );
  assert.equal(streamed.avgTps, 200); // 100 / 0.5 秒
  assert.equal(streamed.avgThroughput, 10); // 100 / 10 秒
});
