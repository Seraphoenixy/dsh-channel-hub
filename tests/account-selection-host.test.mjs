import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Context, Service } from "@deepseek-ai/cordis";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";

test("built hub pins channel accounts, preserves in-flight choices and persists selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chub-account-choice-"));
  const data = join(dir, "profiles", "desktop", "channel-hub");
  mkdirSync(join(data, "channel-pack"), { recursive: true });
  const accounts = ["a", "b"].map((id) => ({
    id,
    provider: "buddy",
    nickname: "Account " + id,
    credentialRef: "TEST_" + id.toUpperCase(),
    enabled: true,
    refreshable: false,
    createdAt: Date.now(),
  }));
  writeFileSync(
    join(data, "channel-pack", "state.json"),
    JSON.stringify({ accounts, disabledModels: {} }),
  );
  const namespace =
    "CHANNEL_HUB_" +
    createHash("sha256").update(data).digest("hex").slice(0, 12) +
    "_";
  const values = new Map(
    accounts.map((a) => [
      namespace + a.credentialRef,
      JSON.stringify({
        access_token: "synthetic-" + a.id,
        domain: "copilot.tencent.com",
      }),
    ]),
  );
  const ctx = new Context();
  class Credentials extends Service {
    constructor(c) {
      super(c, "credentials");
    }
    async resolve(ref) {
      const value = values.get(ref);
      return value ? { value } : undefined;
    }
    async set(ref, value) {
      values.set(ref, value);
    }
    async delete(ref) {
      values.delete(ref);
    }
    async remove(ref) {
      values.delete(ref);
    }
  }
  new Credentials(ctx);
  const llm = new LlmRuntime(ctx);
  const previous = process.env.DSH_HOME,
    originalFetch = globalThis.fetch;
  process.env.DSH_HOME = dir;
  let plugin,
    rejectB = false,
    holdA = false,
    releaseA,
    sawA;
  let gateA = Promise.resolve();
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const id = new Headers(init?.headers)
      .get("authorization")
      ?.endsWith("synthetic-b")
      ? "b"
      : "a";
    if (url.endsWith("/v3/config"))
      return Response.json({
        data: {
          models: [
            { id: "hy3", name: "Hy3", maxInputTokens: 32000 },
            { id: "only-" + id, name: "Only " + id },
          ],
          agents: [{ name: "craft", models: ["hy3", "only-" + id] }],
        },
      });
    if (url === "https://copilot.tencent.com/v2/chat/completions") {
      sent.push(id);
      if (holdA && id === "a") {
        sawA?.();
        await gateA;
      }
      if (rejectB && id === "b")
        return new Response(JSON.stringify({ code: 429, msg: "rate limit" }), {
          status: 429,
        });
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.startsWith("https://copilot.tencent.com/"))
      return Response.json({ code: 0, data: { active: false } });
    throw Error("Unexpected fixture endpoint " + url);
  };
  const select = (accountId) =>
    plugin.dispatch("channels.selectAccount", { provider: "buddy", accountId });
  const channel = async () =>
    (await plugin.dispatch("channels.list")).find((c) => c.id === "buddy");
  const modelIds = async () =>
    (await llm.listModels("channel-hub/buddy")).map((m) => m.id).sort();
  const prepare = () =>
    llm.prepareCall({
      provider: "channel-hub/buddy",
      model: "hy3",
      maxTokens: 512,
    });
  const consume = async (prepared) => {
    const chunks = [];
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [
        createUserMessage({ content: [{ type: "text", text: "Reply OK" }] }),
      ],
      tools: [],
    }))
      chunks.push(chunk);
    return chunks;
  };
  const request = async () => consume(await prepare());
  const success = (chunks) =>
    chunks.some((c) => c.type === "text-delta" && c.text === "OK");
  try {
    const { apply } = await import("../dist/index.js");
    plugin = await apply(ctx);
    await plugin.dispatch("models.refresh", { provider: "buddy" });
    assert.deepEqual(await modelIds(), ["hy3", "only-a", "only-b"]);
    assert.equal((await channel()).selectedAccountId, null);
    assert.ok(success(await request()));
    assert.deepEqual(sent, ["a"]);
    await select("b");
    assert.deepEqual(await modelIds(), ["hy3", "only-b"]);
    assert.ok(success(await request()));
    assert.equal(sent.at(-1), "b");
    await assert.rejects(
      plugin.dispatch("channels.selectAccount", {
        provider: "trae",
        accountId: "b",
      }),
      /不属于/,
    );
    await assert.rejects(select("missing"), /不存在/);
    assert.equal((await channel()).selectedAccountId, "b");

    await select("a");
    holdA = true;
    gateA = new Promise((resolve) => (releaseA = resolve));
    const entered = new Promise((resolve) => (sawA = resolve));
    const runningA = request();
    await entered;
    await select("b");
    assert.ok(success(await request()));
    releaseA();
    assert.ok(success(await runningA));
    holdA = false;
    const records = await plugin.dispatch("requests.list", {
      provider: "buddy",
    });
    assert.equal(records.total, 4);
    assert.equal(
      records.items.filter((r) => r.attempts[0]?.accountId === "a").length,
      2,
    );
    assert.equal(
      records.items.filter((r) => r.attempts[0]?.accountId === "b").length,
      2,
    );

    await select("a");
    const oldModel = await llm.prepareCall({
      provider: "channel-hub/buddy",
      model: "only-a",
      maxTokens: 512,
    });
    await select("b");
    const beforeUnsupported = sent.length;
    assert.match(JSON.stringify(await consume(oldModel)), /不支持该模型/);
    assert.equal(
      sent.length,
      beforeUnsupported,
      "a stale model choice must not use another account",
    );

    const stale = await prepare();
    await plugin.dispatch("accounts.update", { id: "b", enabled: false });
    assert.deepEqual(await modelIds(), []);
    const beforeDisabled = sent.length;
    const disabledChunks = await consume(stale);
    assert.match(JSON.stringify(disabledChunks), /停用/);
    assert.equal(sent.length, beforeDisabled);
    await plugin.dispatch("accounts.update", { id: "b", enabled: true });
    await select("b");

    rejectB = true;
    const beforeRateLimit = sent.length;
    const limited = await request();
    assert.ok(
      limited.some((c) => c.type === "finish" && c.reason.kind === "error"),
    );
    assert.deepEqual(
      sent.slice(beforeRateLimit),
      ["b"],
      "fixed account must never rotate to a",
    );
    await select(null);
    assert.ok(success(await request()));
    assert.equal(sent.at(-1), "a");

    await select("b");
    await plugin.dispatch("accounts.delete", { id: "b" });
    assert.equal((await channel()).selectedAccountId, "b");
    assert.deepEqual(await modelIds(), []);
    await select(null);
    assert.deepEqual(await modelIds(), ["hy3", "only-a"]);
    await select("a");
    await plugin.stop();
    plugin = await apply(ctx);
    assert.equal(
      (await channel()).selectedAccountId,
      "a",
      "choice survives plugin restart",
    );
  } finally {
    releaseA?.();
    await plugin?.stop();
    await ctx.stop?.();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
