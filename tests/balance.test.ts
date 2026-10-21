import test from "node:test";
import assert from "node:assert/strict";
import { BalanceService } from "../src/core/balance.ts";
import { RenewalService } from "../src/core/renewal.ts";
import type { Account } from "../src/core/types.ts";

const account = (id = "one"): Account => ({ id, provider: "buddy", nickname: id, credentialRef: id, enabled: true });
const validBalance = { total: 42, packages: [] };
function fixture(query: (a: Account) => Promise<unknown>) {
  let now = 1000000;
  const accounts = [account(), { ...account("disabled"), enabled: false }];
  const values = new Map<string, any>();
  const warnings: string[] = [];
  const service = new BalanceService({
    accounts: async () => accounts,
    getAccount: (id) => accounts.find(a => a.id === id),
    supports: () => true, query,
    store: { async call(method: string, key: string, value?: unknown) {
      if (method === "set") values.set(key, value);
      return values.get(key);
    } } as any,
    logger: { warn: (s) => warnings.push(s) }, now: () => now,
  });
  return { service, accounts, values, warnings, advance: (ms: number) => { now += ms; } };
}
const flush = () => new Promise<void>(r => setImmediate(r));

test("balance polling starts automatically, respects five-minute freshness and stops", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const f = fixture(async () => { calls++; return validBalance; });
  try {
    f.service.start();
    await flush();
    assert.equal(calls, 2, "disabled accounts still keep fresh account metadata");
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(calls, 2);
    f.advance(300000);
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(calls, 4);
    await f.service.stop();
    f.advance(300000);
    t.mock.timers.tick(300000);
    await flush();
    assert.equal(calls, 4);
  } finally { await f.service.stop(); }
});

test("automatic and manual balance queries share a flight", async () => {
  let complete!: () => void;
  let calls = 0;
  const gate = new Promise<void>(r => { complete = r; });
  const f = fixture(async () => { calls++; await gate; return validBalance; });
  f.accounts.splice(1);
  const tick = f.service.tick();
  await flush();
  const manual = f.service.refresh(f.accounts[0]);
  assert.equal(f.service.tick(), tick);
  assert.equal(calls, 1);
  complete();
  await Promise.all([tick, manual]);
  assert.equal(calls, 1);
  await f.service.stop();
});

test("balance errors back off without losing prior reading; other accounts proceed", async () => {
  let badCalls = 0;
  const f = fixture(async a => {
    if (a.id === "one") { badCalls++; throw Error("upstream unavailable"); }
    return validBalance;
  });
  f.values.set("balance:one", { at: 1, value: validBalance });
  await f.service.tick();
  assert.equal(f.values.get("balance:one").value.total, 42);
  assert.equal(f.values.get("balance:one").at, 1);
  assert.equal(f.values.get("balance:disabled").value.total, 42);
  await f.service.tick();
  assert.equal(badCalls, 1);
  f.advance(30000);
  await f.service.tick();
  assert.equal(badCalls, 2);
  f.advance(30000);
  await f.service.tick();
  assert.equal(badCalls, 2, "second failure waits one minute");
  await f.service.stop();
});

test("null balance preserves last success and shutdown drains in-flight queries", async () => {
  let complete!: () => void;
  const gate = new Promise<void>(r => { complete = r; });
  const f = fixture(async () => { await gate; return null; });
  f.values.set("balance:one", { at: 1, value: validBalance });
  const query = f.service.refresh(f.accounts[0]);
  const rejected = assert.rejects(query);
  let closed = false;
  const stop = f.service.stop().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false);
  complete();
  await Promise.all([stop, rejected]);
  assert.equal(f.values.get("balance:one").value.total, 42);
  await assert.rejects(f.service.refresh(f.accounts[0]), /已停止/);
});

test("removed or replaced accounts do not receive old balance results", async () => {
  let complete!: () => void;
  const f = fixture(async () => { await new Promise<void>(r => { complete = r; }); return validBalance; });
  const job = f.service.refresh(f.accounts[0]);
  const rejected = assert.rejects(job, /账号已变更/);
  f.accounts[0] = { ...f.accounts[0], credentialRef: "new-login" };
  complete();
  await rejected;
  assert.equal(f.values.has("balance:one"), false);
  await f.service.stop();
});

test("renewal starts without UI and periodically checks known expiries", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let expiry = Date.now() + 4 * 86400000;
  let calls = 0;
  const service = new RenewalService(async () => [
    { ...account(), expiresAt: expiry, refreshable: true, enabled: false },
    { ...account("unknown"), refreshable: true },
  ], async a => { assert.equal(a.id, "one"); calls++; expiry = Date.now() + 7 * 86400000; });
  try {
    service.start();
    await flush();
    assert.equal(calls, 0);
    expiry = Date.now() + 3 * 86400000;
    t.mock.timers.tick(3600000 - 1);
    await flush();
    assert.equal(calls, 0, "early renewal waits for the hourly scan");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(3600000);
    await flush();
    assert.equal(calls, 1);
  } finally { await service.stop(); }
});

test("renewal shutdown drains a refresh and prevents later periodic work", async () => {
  let complete!: () => void;
  let calls = 0;
  const a = { ...account(), expiresAt: 1, refreshable: true };
  const service = new RenewalService(async () => [a], async () => {
    calls++;
    await new Promise<void>(r => { complete = r; });
  });
  const refresh = service.renew(a);
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  complete();
  await Promise.all([stop, refresh]);
  await service.tick();
  await assert.rejects(service.renew(a), /已停止/);
  assert.equal(calls, 1);
});

test("a renewed short-lived token is not rotated on every scan or balance query", async () => {
  const a = { ...account(), expiresAt: Date.now() + 1000, refreshable: true };
  let calls = 0;
  const service = new RenewalService(async () => [a], async () => {
    calls++;
    a.expiresAt = Date.now() + 3600000;
  });
  try {
    await service.tick();
    await service.tick();
    await service.renew(a, false);
    assert.equal(calls, 1);
    await service.renew(a);
    assert.equal(calls, 2, "manual renewal can still be requested immediately");
  } finally { await service.stop(); }
});
