/**
 * 账号删除后的快照清理（`src/core/account-cleanup.ts`）。
 *
 * 夹具是**内存键值表**，不联网、不读写真实数据库。键名按写入方逐条核对：
 * 任何一处与写入方漂移，删号就会重新回到「留下孤儿键」的老状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  accountSnapshotKeys,
  orphanAccounts,
  purgeAccountCredential,
  purgeAccountSnapshots,
} from "../src/core/account-cleanup.ts";
import type { Store } from "../src/storage/client.ts";
import type { Account } from "../src/core/types.ts";

/** 内存 store：记录调用顺序，`failKeys` 里的键抛错以模拟库被锁。 */
function memoryStore(
  initial: Record<string, unknown> = {},
  failKeys: Set<string> = new Set(),
) {
  const rows = new Map<string, unknown>(Object.entries(initial));
  const calls: Array<{ method: string; key: string }> = [];
  const store: Store & { rows: Map<string, unknown>; calls: typeof calls } = {
    rows,
    calls,
    async call<T>(method: string, ...args: any[]): Promise<T> {
      const key = String(args[0]);
      calls.push({ method, key });
      if (method !== "del") throw Error("意外的数据库操作：" + method);
      if (failKeys.has(key)) throw Error("database is locked");
      rows.delete(key);
      return undefined as T;
    },
  };
  return store;
}

const account = { id: "buddy-1", provider: "buddy" };

test("快照键与四个写入方逐条对应", () => {
  assert.deepEqual(accountSnapshotKeys(account), [
    // drivers/ofm.js: catalog.refresh(id + ":" + a.id, …)
    "catalog:buddy:buddy-1",
    // core/balance.ts: store.call("set", "balance:" + a.id, …)
    "balance:buddy-1",
    // core/checkin.ts: store.call("set", "checkin:" + a.id, …)
    "checkin:buddy-1",
    // storage/database.ts begin(): set("identity:" + provider + "/" + accountId, …)
    "identity:buddy/buddy-1",
  ]);
});

test("删号清理掉全部四个键，且只发 del", async () => {
  const store = memoryStore({
    "catalog:buddy:buddy-1": { models: [] },
    "balance:buddy-1": { at: 1, value: null },
    "checkin:buddy-1": { day: "2026-10-21", state: "done" },
    "identity:buddy/buddy-1": "Buddy One",
    "balance:buddy-2": { at: 1, value: null },
    "checkin:qodercn-1": { day: "2026-10-21", state: "done" },
  });

  const result = await purgeAccountSnapshots(store, account);

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.purged, accountSnapshotKeys(account));
  assert.deepEqual(
    [...store.rows.keys()].sort(),
    ["balance:buddy-2", "checkin:qodercn-1"],
    "只删这个账号自己的键，别的账号与渠道级键不受影响",
  );
  assert.equal(
    store.calls.every((c) => c.method === "del"),
    true,
    "清理不得写入或改键",
  );
});

test("重复清理是幂等的，不抛错", async () => {
  const store = memoryStore({ "checkin:buddy-1": { state: "done" } });
  await purgeAccountSnapshots(store, account);
  const again = await purgeAccountSnapshots(store, account);
  assert.deepEqual(again.failed, []);
  assert.deepEqual(again.purged, accountSnapshotKeys(account));
});

test("单个键删除失败只记 warn，其余照删且不拖垮删号", async () => {
  const warnings: string[] = [];
  const store = memoryStore(
    {
      "catalog:buddy:acc-1": { models: [] },
      "balance:acc-1": { at: 1, value: null },
      "checkin:acc-1": { state: "done" },
      "identity:buddy/acc-1": "Acc One",
    },
    new Set(["balance:acc-1"]),
  );
  const result = await purgeAccountSnapshots(
    store,
    { id: "acc-1", provider: "buddy" },
    { warn: (message) => warnings.push(message) },
  );

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, "balance:acc-1");
  assert.match(result.failed[0].error, /database is locked/);
  assert.deepEqual(
    result.purged,
    ["catalog:buddy:acc-1", "checkin:acc-1", "identity:buddy/acc-1"],
    "单个键失败不影响其余三个键",
  );
  assert.deepEqual([...store.rows.keys()], ["balance:acc-1"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /账号快照清理失败/);
});

/**
 * 凭据注销（`purgeAccountCredential`）。
 *
 * 这一组钉死的是宿主 API 的**真实方法面**：`ctx.credentials` 只有
 * `resolve` / `describe` / `set` / `unset`。旧实现写 `credentials.delete?.()`，
 * 在真实宿主上抛 `TypeError`，又因为调用点在 `removeAccount()` 之后，
 * 表现为「弹报错但账号确实被删掉了」，并顺手跳过了快照与凭据清理。
 */
test("按宿主真实 API 用 unset 注销凭据", async () => {
  const refs: string[] = [];
  const credentials = {
    async unset(ref: string) {
      refs.push(ref);
    },
  };
  assert.equal(await purgeAccountCredential(credentials, "ACCOUNT_x"), true);
  assert.deepEqual(refs, ["ACCOUNT_x"]);
});

test("宿主没有 delete 时不得抛错（这正是旧实现的失败方式）", async () => {
  const warnings: string[] = [];
  // 只有 unset：完整镜像真实服务，没有任何 delete / remove。
  const credentials = { async unset() {} };
  assert.equal(
    await purgeAccountCredential(credentials, "ACCOUNT_x", {
      warn: (m: string) => warnings.push(m),
    }),
    true,
  );
  assert.deepEqual(warnings, [], "正常的 unset 不该产生告警");

  // 服务上根本没有注销方法（宿主未提供凭据能力）：静默跳过，不抛错。
  assert.equal(await purgeAccountCredential({}, "ACCOUNT_x"), false);
  assert.equal(await purgeAccountCredential(undefined, "ACCOUNT_x"), false);
});

test("旧宿主的 delete 与 remove 仍被接受", async () => {
  const removed: string[] = [];
  assert.equal(
    await purgeAccountCredential(
      { async delete(ref: string) { removed.push(ref); } },
      "ACCOUNT_a",
    ),
    true,
  );
  assert.equal(
    await purgeAccountCredential(
      { async remove(ref: string) { removed.push(ref); } },
      "ACCOUNT_b",
    ),
    true,
  );
  assert.deepEqual(removed, ["ACCOUNT_a", "ACCOUNT_b"]);
});

test("注销失败只记 warn，绝不把删号变成失败", async () => {
  const warnings: string[] = [];
  const credentials = {
    async unset() {
      throw Error("credentials file is locked");
    },
  };
  assert.equal(
    await purgeAccountCredential(credentials, "ACCOUNT_x", {
      warn: (m: string) => warnings.push(m),
    }),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /账号凭据清理失败/);
  assert.match(warnings[0], /locked/);
});

test("渠道未注册的账号被识别出来，且不误伤已注册渠道", () => {
  const accounts: Account[] = [
    { id: "buddy-1", provider: "buddy", nickname: "B", credentialRef: "R1", enabled: true },
    { id: "zcode-1", provider: "zcode", nickname: "Z", credentialRef: "R2", enabled: true },
    { id: "gone-1", provider: "gone", nickname: "G", credentialRef: "R3", enabled: true },
  ];
  const orphans = orphanAccounts(accounts, ["buddy", "trae"]);
  assert.deepEqual(
    orphans.map((a) => a.id),
    ["zcode-1", "gone-1"],
  );
  assert.deepEqual(orphanAccounts(accounts, ["buddy", "trae", "zcode", "gone"]), []);
});
