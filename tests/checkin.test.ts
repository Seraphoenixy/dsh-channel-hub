import test from "node:test";
import assert from "node:assert/strict";
import { CheckinService } from "../src/core/checkin.ts";
import type { Account } from "../src/core/types.ts";

function fixture(claim: (a: Account) => Promise<any>, mode: "auto" | "manual" | "unsupported" = "auto") {
  let now = Date.parse("2026-10-21T01:00:00+08:00");
  const accounts: Account[] = [{ id: "one", provider: "qoder", credentialRef: "REF", nickname: "Synthetic", enabled: false }];
  const values = new Map<string, any>();
  let updates = 0;
  const options = {
    accounts: async () => accounts, getAccount: (id: string) => accounts.find(a => a.id === id),
    mode: () => mode, claim, afterClaim: async () => { updates++; },
    store: { async call(method: string, key: string, value?: unknown) { if (method === "set") values.set(key, value); return values.get(key); } } as any,
    logger: { warn() {} }, now: () => now,
  };
  const service = new CheckinService(options);
  return { service, options, accounts, values, advance: (ms: number) => { now += ms; }, updates: () => updates };
}
const flush = () => new Promise<void>(r => setImmediate(r));

test("automatic checkin starts without UI, persists daily success across restarts and refreshes balance", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const f = fixture(async () => { calls++; return { kind: "claimed", credit: 100 }; });
  f.service.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal((await f.service.status(f.accounts[0])).label, "今日已签到");
  assert.match((await f.service.status(f.accounts[0])).message!, /100/);
  assert.equal(f.updates(), 1);
  t.mock.timers.tick(300000);
  await flush();
  assert.equal(calls, 1);
  await f.service.stop();
  const restarted = new CheckinService(f.options);
  await restarted.tick();
  assert.equal(calls, 1);
  f.advance(86400000);
  await restarted.tick();
  assert.equal(calls, 2);
  await restarted.stop();
});

test("pre-refresh Qoder result never marks today complete", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return calls === 1 ? { kind: "already-claimed", coversToday: false } : { kind: "already-claimed" }; });
  await f.service.tick();
  assert.equal((await f.service.status(f.accounts[0])).state, "waiting");
  await f.service.tick();
  assert.equal(calls, 1);
  f.advance(3600000);
  await f.service.tick();
  assert.equal((await f.service.status(f.accounts[0])).state, "done");
  await f.service.stop();
});

test("inactive Qoder before campaign refresh is displayed as waiting, not absent activity", async () => {
  const f = fixture(async () => ({ kind: "inactive", coversToday: false, message: "等待活动刷新" }));
  await f.service.tick();
  assert.equal((await f.service.status(f.accounts[0])).state, "waiting");
  assert.equal((await f.service.status(f.accounts[0])).label, "等待本轮活动刷新");
  await f.service.stop();
});

test("failed and inactive outcomes stay distinct and retry after delay", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return calls === 1 ? { kind: "failed", message: "unavailable" } : { kind: "inactive", message: "activity not active" };
  });
  await f.service.tick();
  assert.equal((await f.service.status(f.accounts[0])).state, "failed");
  await f.service.tick();
  assert.equal(calls, 1);
  f.advance(300000);
  await f.service.tick();
  assert.equal((await f.service.status(f.accounts[0])).state, "inactive");
  assert.equal(f.updates(), 0);
  await f.service.stop();
});

test("manual and unsupported channels do not issue unattended claims", async () => {
  for (const mode of ["manual", "unsupported"] as const) {
    let calls = 0;
    const f = fixture(async () => { calls++; return { kind: "already-claimed" }; }, mode);
    await f.service.tick();
    assert.equal(calls, 0);
    assert.equal((await f.service.status(f.accounts[0])).state, mode);
    if (mode === "manual") { await f.service.run(f.accounts[0], true); assert.equal(calls, 1); }
    await f.service.stop();
  }
});

test("automatic and manual checkin share a task; stop drains it", async () => {
  let complete!: () => void;
  let calls = 0;
  const f = fixture(async () => { calls++; await new Promise<void>(r => { complete = r; }); return { kind: "already-claimed" }; });
  const task = f.service.run(f.accounts[0]);
  await flush();
  assert.equal((await f.service.status(f.accounts[0])).state, "running");
  assert.equal(f.service.run(f.accounts[0], true), task);
  let stopped = false;
  const stop = f.service.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  complete(); await Promise.all([task, stop]);
  assert.equal(calls, 1);
});

test("an old checkin result cannot overwrite a replaced account", async () => {
  let complete!: () => void;
  const f = fixture(async () => { await new Promise<void>(r => { complete = r; }); return { kind: "claimed", credit: 10 }; });
  const task = f.service.run(f.accounts[0]);
  const rejected = assert.rejects(task, /账号已变更/);
  await flush();
  f.accounts[0] = { ...f.accounts[0], credentialRef: "NEW_REF" };
  complete(); await rejected;
  assert.equal(f.values.size, 0);
  assert.equal(f.updates(), 0);
  await f.service.stop();
});
