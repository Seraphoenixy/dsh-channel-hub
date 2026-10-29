import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Extracted host package does not ship declarations.
import { Context, Service } from "@deepseek-ai/cordis";
import { installSessionModelIsolation } from "../src/host/session-model.ts";

function fixture() {
  const ctx = new Context();
  let defaultModel = { provider: "test", model: "a", reasoningEffort: "high" };
  const states = new WeakMap<object, any>();
  class Defaults extends Service {
    constructor() { super(ctx, "agentDefaultModel"); }
    currentSelection() { return defaultModel; }
  }
  class Projections extends Service {
    constructor() { super(ctx, "sessionProjections"); }
    stateOf(session: object) { return states.get(session); }
  }
  new Defaults();
  new Projections();
  const fiber = ctx.plugin(installSessionModelIsolation);
  const create = async (header = {}, pending: any = null, logged: any = undefined) => {
    while (fiber.inertia) await fiber.inertia;
    const local = new Context();
    const state = { pending };
    const session = {
      header,
      requestHeader: () => logged,
      append(type: string, value: any) {
        assert.equal(type, "model/selection");
        state.pending = value;
      },
    };
    states.set(session, state);
    // Mirror the host's live-default fallback installed before agent/created.
    const picked = pending;
    let selected: any;
    local.on("system-prompt/assemble", async (_a: any, _c: any, next: any) => {
      selected = picked ?? logged?.config ?? defaultModel;
      const result = await next();
      return { ...result, variables: { ...result.variables, ...selected } };
    });
    local.on("agent/request", async (_p: any, next: any) => ({ ...await next(), ...selected }));
    const agent = { ctx: local, session };
    await ctx.serial("agent/created", { agent });
    return {
      state,
      log: (config: any) => { logged = { config }; state.pending = null; },
      assemble: (next = async () => ({ variables: {} })) => local.waterfall("system-prompt/assemble", {}, {}, next),
      request: () => local.waterfall("agent/request", {}, async () => ({})),
    };
  };
  return { ctx, dispose: () => fiber.dispose(), create, change: (model: string) => { defaultModel = { ...defaultModel, model }; } };
}

test("new sessions keep independent defaults through their first request", async () => {
  const f = fixture();
  try {
    const a = await f.create();
    f.change("b");
    const b = await f.create();
    f.change("c");
    assert.equal((await a.assemble()).variables.model, "a");
    assert.equal((await a.request()).model, "a");
    assert.equal((await b.assemble()).variables.model, "b");
    assert.equal((await b.request()).model, "b");
    a.log({ provider: "test", model: "a" });
    await a.assemble();
    assert.equal((await a.request()).model, "a");
  } finally { await f.dispose(); }
});

test("explicit selection and effort clearing win; assembly snapshots survive a concurrent pick", async () => {
  const f = fixture();
  try {
    const a = await f.create();
    a.state.pending = { provider: "other", model: "explicit" };
    const assembled = await a.assemble(async () => {
      a.state.pending = { provider: "test", model: "later" };
      return { variables: {} };
    });
    assert.equal(assembled.variables.model, "explicit");
    assert.deepEqual(await a.request(), { provider: "other", model: "explicit" });
    await a.assemble();
    assert.equal((await a.request()).model, "later");
  } finally { await f.dispose(); }
});

test("existing selections, request history, branches and subagents are not seeded", async () => {
  const f = fixture();
  try {
    const pending = { provider: "test", model: "picked" };
    assert.equal((await f.create({}, pending)).state.pending, pending);
    assert.equal((await f.create({}, null, { config: pending })).state.pending, null);
    assert.equal((await f.create({ origin: "subagent" })).state.pending, null);
    assert.equal((await f.create({ parentSession: "parent" })).state.pending, null);
  } finally { await f.dispose(); }
});


