/**
 * 存储层回归：记账故障不得拖住推理（`WorkerStore`），统计过滤下推后口径不变。
 * 全部使用内存数据库与替身工作线程，不联网、不读写真实数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkerStore,
  STORE_MAX_PENDING_ENV,
  STORE_TIMEOUT_ENV,
  type WorkerLike,
} from "../src/storage/client.ts";
import { LedgerDatabase } from "../src/storage/database.ts";

/** 可手动触发事件的工作线程替身。 */
const fakeWorker = () => {
  const listeners = new Map<string, ((value: any) => void)[]>();
  const worker: WorkerLike & { emit(event: string, value: any): void } = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return worker;
    },
    postMessage() {},
    terminate() {},
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
  };
  return worker;
};

const withEnv = async (env: Record<string, string>, run: () => Promise<void>) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("工作线程在 ready 之前退出时，调用立即失败而不是永久悬挂", async () => {
  const worker = fakeWorker();
  const store = new WorkerStore(":memory:", worker);
  worker.emit("exit", 1);
  await assert.rejects(store.call("get", "k"), /exited: 1/);
});

test("工作线程卡死时，单次调用按超时失败（记账不影响模型输出）", async () => {
  await withEnv({ [STORE_TIMEOUT_ENV]: "30" }, async () => {
    const worker = fakeWorker();
    const store = new WorkerStore(":memory:", worker);
    worker.emit("message", { ready: true });
    await assert.rejects(store.call("get", "k"), /记账超时/);
    // 超时后该调用已从待处理表摘除，迟到的回包不会二次结算。
    assert.equal((store as any).pending.size, 0);
  });
});

test("未完成调用超过上限时快速失败，不无限堆积", async () => {
  await withEnv(
    { [STORE_TIMEOUT_ENV]: "200", [STORE_MAX_PENDING_ENV]: "1" },
    async () => {
      const worker = fakeWorker();
      const store = new WorkerStore(":memory:", worker);
      worker.emit("message", { ready: true });
      const first = store.call("get", "a");
      await assert.rejects(store.call("get", "b"), /队列已满/);
      await assert.rejects(first, /记账超时/);
    },
  );
});

test("正常握手与回包仍然可用", async () => {
  const worker = fakeWorker();
  const store = new WorkerStore(":memory:", worker);
  worker.emit("message", { ready: true });
  const pending = store.call("get", "k");
  // `call` 里 `await this.ready` 会让注册待处理晚一个微任务，先让出一拍。
  await new Promise((resolve) => setImmediate(resolve));
  worker.emit("message", { id: 1, result: 42 });
  assert.equal(await pending, 42);
});

test("kv 删除是幂等的，并如实返回删掉的函数（账号快照清理依赖它）", () => {
  const db = new LedgerDatabase(":memory:");
  try {
    db.set("checkin:acc1", { day: "2026-10-21" });
    db.set("checkin:acc2", { day: "2026-10-21" });
    assert.equal(db.del("checkin:acc1"), 1, "存在的键删掉一行");
    assert.equal(db.del("checkin:acc1"), 0, "重复删除不抛错，返回 0");
    assert.equal(db.get("checkin:acc1"), undefined);
    assert.deepEqual(db.get("checkin:acc2"), { day: "2026-10-21" }, "不误删别的键");
  } finally {
    db.close();
  }
});

test("统计过滤下推后口径不变（日期 / 渠道 / 模型 / 账号）", () => {
  const db = new LedgerDatabase(":memory:");
  const add = (
    id: string,
    provider: string,
    model: string,
    accountId: string,
    started: number,
    output: number,
  ) => {
    const req = {
      id,
      turnId: id,
      provider,
      model,
      started,
      outcome: "running" as const,
    };
    db.begin(req);
    db.finish({ ...req, outcome: "success", ended: started + 1000 }, [
      {
        id: "at-" + id,
        requestId: id,
        provider,
        model,
        accountId,
        started,
        ended: started + 1000,
        outcome: "success",
        usage: { input: 5, output },
      },
    ]);
  };
  try {
    const day20 = Date.parse("2026-10-20T10:00:00+08:00");
    add("r1", "buddy", "hy3", "acc1", day20, 100);
    add("r2", "buddy", "hy3", "acc2", day20 + 3600000, 50);
    add("r3", "trae", "glm", "acc1", Date.parse("2026-10-21T09:00:00+08:00"), 30);

    const all = db.stats({});
    assert.equal(all.totals.requests, 3);
    assert.equal(all.totals.output, 180);
    assert.equal(all.accounts.length, 3, "三个账号（含跨渠道的 acc1）");
    assert.equal(all.models.length, 2);

    const today = db.stats({ from: Date.parse("2026-10-21T00:00:00+08:00") });
    assert.equal(today.totals.requests, 1, "只算当天");
    assert.equal(today.totals.output, 30);

    const buddy = db.stats({ provider: "buddy" });
    assert.equal(buddy.totals.requests, 2);
    assert.equal(buddy.providers.length, 1);

    const glm = db.stats({ model: "glm" });
    assert.equal(glm.totals.requests, 1);

    // 选账号时按该账号的物理行统计（与改动前一致）。
    const one = db.stats({ accountId: "acc1" });
    assert.equal(one.totals.requests, 2);
    assert.deepEqual(
      one.accounts.map((a: any) => a.id).sort(),
      ["buddy/acc1", "trae/acc1"],
    );
  } finally {
    db.close();
  }
});

test("同一模型名跨渠道时按渠道分开统计，并回传来源字段", () => {
  // 真实缺陷（2026-10-21，用户要求「名称列体现来源」时发现）：旧实现只按
  // 模型名分组，而同一模型名会出现在多个渠道上 —— 实测 deepseek-v4.1-flash
  // 横跨 workbuddy / trae / codearts / buddy 四个渠道，合并后速度被算成
  // 一个平均值，无法判断「是哪个渠道慢」。
  const db = new LedgerDatabase(":memory:");
  const add = (id: string, provider: string, model: string, accountId: string, started: number) => {
    const req = {
      id,
      turnId: id,
      provider,
      model,
      started,
      outcome: "running" as const,
    };
    db.begin(req);
    db.finish({ ...req, outcome: "success", ended: started + 1000 }, [
      {
        id: "at-" + id,
        requestId: id,
        provider,
        model,
        accountId,
        started,
        ended: started + 1000,
        outcome: "success",
        usage: { input: 5, output: 10 },
      },
    ]);
  };
  try {
    const at = Date.parse("2026-10-21T10:00:00+08:00");
    // 同一个模型名挂在两个渠道上。
    add("m1", "buddy", "shared-model", "acc1", at);
    add("m2", "trae", "shared-model", "acc2", at + 1000);

    const all = db.stats({});
    assert.equal(
      all.models.length,
      2,
      "同名模型在两个渠道上必须是两行，不能被合并",
    );
    assert.deepEqual(
      all.models.map((m: any) => m.id).sort(),
      ["buddy/shared-model", "trae/shared-model"],
    );
    // 每个分组都带回结构化的来源与裸模型名，界面才能拼「来源 / 名称」。
    for (const row of all.models) {
      assert.ok(row.provider === "buddy" || row.provider === "trae", String(row.provider));
      assert.equal(row.model, "shared-model");
      /*
       * ⚠️ 真实缺陷（2026-10-23）：`name` 在 identity 无记录时曾回退成**复合键**
       * `provider/model`，而界面又在它前面单独渲染了 `provider` ——
       * 结果是 `buddy / buddy/shared-model`，来源被拼了两次。
       * 兜底必须是裸模型名。
       */
      assert.equal(
        row.name,
        "shared-model",
        "identity 无记录时 name 必须是裸模型名，不能是 provider/model 复合键",
      );
      assert.equal(
        row.provider + " / " + row.name,
        row.provider + " / shared-model",
        "「来源 / 名称」只能出现一次来源",
      );
    }
    // 账号分组同样带上来源与账号 id。
    for (const row of all.accounts) {
      assert.equal(typeof row.provider, "string");
      assert.equal(typeof row.accountId, "string");
      assert.equal(row.id, row.provider + "/" + row.accountId);
      // 同上：兜底是裸账号 id，不能是 provider/accountId。
      assert.equal(
        row.name,
        row.accountId,
        "identity 无记录时 name 必须是裸账号 id，不能是复合键",
      );
    }
  } finally {
    db.close();
  }
});

test("每日消耗按来源分别统计，且排序稳定", () => {
  // 用户 2026-10-21 要求「每日 token 消耗按来源分别统计绘制」：
  // 旧的 series 只按日期分组，所有渠道混成一根柱子，看不出是哪家吃掉了额度。
  const db = new LedgerDatabase(":memory:");
  const add = (
    id: string,
    provider: string,
    started: number,
    output: number,
  ) => {
    const req = {
      id,
      turnId: id,
      provider,
      model: "m",
      started,
      outcome: "running" as const,
    };
    db.begin(req);
    db.finish({ ...req, outcome: "success", ended: started + 1000 }, [
      {
        id: "at-" + id,
        requestId: id,
        provider,
        model: "m",
        accountId: "acc",
        started,
        ended: started + 1000,
        outcome: "success",
        usage: { input: 0, output },
      },
    ]);
  };
  try {
    const d20 = Date.parse("2026-10-20T10:00:00+08:00");
    const d21 = Date.parse("2026-10-21T10:00:00+08:00");
    // 10-20：buddy 多、trae 少；10-21：trae 多（跨天换主力渠道）。
    add("a", "buddy", d20, 100);
    add("b", "trae", d20 + 1000, 10);
    add("c", "trae", d21, 800);
    add("d", "buddy", d21 + 1000, 20);

    const rows = db.stats({}).dailyByProvider as any[];
    assert.equal(rows.length, 4, "两天 × 两个渠道 = 四行");
    // 按日期升序，便于界面直接按天分组。
    assert.deepEqual(
      rows.map((r) => r.day),
      ["2026-10-20", "2026-10-20", "2026-10-21", "2026-10-21"],
    );
    // 同一天内按 Token 降序 —— 堆叠顺序与图例顺序都由它决定，必须稳定。
    assert.deepEqual(
      rows.map((r) => r.provider),
      ["buddy", "trae", "trae", "buddy"],
    );
    assert.deepEqual(
      rows.map((r) => r.totalTokens),
      [100, 10, 800, 20],
    );
    // 每天各渠道之和应等于当日汇总，两者不能对不上。
    const series = db.stats({}).series as any[];
    for (const day of series) {
      const sum = rows
        .filter((r) => r.day === day.id)
        .reduce((n, r) => n + r.totalTokens, 0);
      assert.equal(sum, day.totalTokens, day.id + " 的分渠道之和必须等于当日汇总");
    }
  } finally {
    db.close();
  }
});

test("落库时 attempt 未定稿也写入速度样本（daily 不再恒为 0）", () => {
  const db = new LedgerDatabase(":memory:");
  try {
    const req = {
      id: "r",
      turnId: "r",
      provider: "p",
      model: "m",
      started: 0,
      outcome: "running" as const,
    };
    db.begin(req);
    // 真实形态：适配器先结束迭代，attempt 仍是 running、没有 ended。
    db.finish({ ...req, outcome: "success", ended: 10_000 }, [
      {
        id: "a",
        requestId: "r",
        provider: "p",
        model: "m",
        accountId: "acc",
        started: 1000,
        outcome: "running",
        first: 5000,
        usage: { input: 1, output: 100 },
      } as any,
    ]);
    const row = (db as any).db
      .prepare("SELECT metrics FROM daily WHERE accountId=''")
      .get();
    const metrics = JSON.parse(String(row.metrics));
    assert.equal(metrics.speedSamples, 1);
    assert.equal(metrics.throughputSamples, 1);
    assert.ok(metrics.speedSum > 0);
  } finally {
    db.close();
  }
});

test("统计返回轮次/步数，且随筛选范围变化", () => {
  const db = new LedgerDatabase(":memory:");
  const mk = (id: string, turnId: string, provider: string, started: number) => {
    const req = {
      id,
      turnId,
      provider,
      model: "m",
      started,
      outcome: "running" as const,
    };
    db.begin(req);
    db.finish({ ...req, outcome: "success", ended: started + 500 }, [
      {
        id: "at-" + id,
        requestId: id,
        provider,
        model: "m",
        accountId: "acc",
        started,
        ended: started + 500,
        outcome: "success",
        usage: { input: 1, output: 2 },
      },
    ]);
  };
  try {
    const day20 = Date.parse("2026-10-20T10:00:00+08:00");
    mk("a", "t1", "buddy", day20);
    mk("b", "t1", "buddy", day20 + 1000);
    mk("c", "t2", "trae", Date.parse("2026-10-21T09:00:00+08:00"));

    assert.deepEqual(db.stats({}).counts, { turns: 2, steps: 3 });
    assert.deepEqual(
      db.stats({ from: Date.parse("2026-10-21T00:00:00+08:00") }).counts,
      { turns: 1, steps: 1 },
    );
    assert.deepEqual(db.stats({ provider: "buddy" }).counts, {
      turns: 1,
      steps: 2,
    });
  } finally {
    db.close();
  }
});

test("运行日志的尝试明细一次批量取回（内容与逐条查询一致）", () => {
  const db = new LedgerDatabase(":memory:");
  const mk = (id: string, turnId: string, attemptId: string) => {
    const started = 1000 + Number(id.slice(1)) * 10;
    const req = {
      id,
      turnId,
      provider: "p",
      model: "m",
      started,
      outcome: "running" as const,
    };
    db.begin(req);
    db.finish({ ...req, outcome: "success", ended: started + 100 }, [
      {
        id: attemptId,
        requestId: id,
        provider: "p",
        model: "m",
        accountId: "acc",
        started,
        ended: started + 100,
        outcome: "success",
        usage: { input: 1, output: 2 },
      },
    ]);
  };
  try {
    mk("r1", "t1", "a1");
    mk("r2", "t1", "a2");
    const page = db.list({});
    assert.equal(page.items[0].stepCount, 2);
    assert.deepEqual(
      page.items[0].steps.map((s: any) => s.attempts.map((a: any) => a.id)),
      [["a1"], ["a2"]],
    );
  } finally {
    db.close();
  }
});
