import test from "node:test";
import assert from "node:assert/strict";
import { AccountSelection } from "../src/core/account-selection.ts";
import { Observer } from "../src/core/observer.ts";

test("account selection persists per channel and validates identity and enabled state", async () => {
  const saved = new Map<string, any>();
  const store = {
    async call<T = any>(method: string, key: string, value?: any): Promise<T> {
      if (method === "set") saved.set(key, value);
      return saved.get(key) as T;
    },
  };
  const accounts = [
    { id: "a", provider: "buddy", enabled: true },
    { id: "b", provider: "trae", enabled: true },
    { id: "off", provider: "buddy", enabled: false },
  ];
  const find = (id: string) => accounts.find((a) => a.id === id);
  const selection = new AccountSelection(store, find);
  assert.equal(await selection.get("buddy"), null);
  await selection.set("buddy", "a");
  assert.equal(await new AccountSelection(store, find).get("buddy"), "a");
  assert.equal(await selection.get("trae"), null);
  await assert.rejects(selection.set("buddy", "b"), /不属于/);
  await assert.rejects(selection.set("buddy", "off"), /停用/);
  await assert.rejects(selection.set("buddy", "missing"), /不存在/);
  assert.equal(await selection.get("buddy"), "a");
  accounts.splice(0, 1);
  assert.equal(
    await selection.get("buddy"),
    "a",
    "deleted target must not silently become auto",
  );
  assert.throws(() => selection.requireAccount("buddy", "a"), /不存在/);
  await selection.set("buddy", null);
  assert.equal(await new AccountSelection(store, find).get("buddy"), null);
});

test("parallel requests retain their own explicit account choice", async () => {
  const observer = new Observer({ async call() {} } as any, { warn() {} });
  const choices: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = (requestedAccountId: string) =>
    (async () => {
      for await (const _ of observer.stream(
        "buddy",
        "m",
        () =>
          (async function* () {
            choices.push(observer.context.getStore()!.requestedAccountId!);
            await gate;
            choices.push(observer.context.getStore()!.requestedAccountId!);
            yield { type: "text-delta", text: "OK" };
          })(),
        undefined,
        { requestedAccountId },
      )) {
      }
    })();
  const a = run("a"),
    b = run("b");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([a, b]);
  assert.deepEqual(choices.sort(), ["a", "a", "b", "b"]);
});
