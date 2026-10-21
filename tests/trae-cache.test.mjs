import test from "node:test";
import assert from "node:assert/strict";
import { TraeAdapter } from "../vendor/ofm/src/trae-adapter.ts";
import { Observer } from "../src/core/observer.ts";
import { LedgerDatabase } from "../src/storage/database.ts";

async function record(rawUsage) {
  const db = new LedgerDatabase(":memory:");
  const observer = new Observer({ async call(method, ...args) { return db[method](...args); } }, { warn() {} });
  const adapter = new TraeAdapter({
    credentialRef: "SYNTHETIC_TRAE",
    resolveCredential: async () => {
      observer.bindAccount("synthetic-trae");
      return { access_token: "synthetic", machine_id: "synthetic-machine", device_id: "synthetic-device" };
    },
    refresh: async () => { throw Error("Unexpected refresh"); },
    fetchRemoteModels: async () => [{ id: "glm-5.3-flash", name: "Synthetic model" }],
    fetchImpl: observer.fetcher(async () => new Response(
      'event: output\ndata: {"response":"OK"}\n\n' +
      "event: token_usage\ndata: " + JSON.stringify(rawUsage) + "\n\n" +
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )),
  });
  const chunks = [];
  try {
    for await (const chunk of observer.stream("trae", "glm-5.3-flash", (signal) => adapter.stream({
      model: "glm-5.3-flash", signal, tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }))) chunks.push(chunk);
    const row = db.list().items[0];
    assert.equal(row.outcome, "success");
    return { usage: chunks.find(c => c.type === "usage").usage, attempt: row.attempts[0], metrics: row.metrics, totals: db.stats().totals };
  } finally { await observer.close(); db.close(); }
}

test("Trae live-shaped cache hit reaches host usage and persistent ledger without double counting", async () => {
  const { usage, attempt, metrics, totals } = await record({
    prompt_tokens: 2727, completion_tokens: 36, total_tokens: 2763,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 2688, reasoning_tokens: 33,
    prompt_tokens_total: 0, cache_read_input_tokens_total: 0,
  });
  assert.deepEqual(usage, { inputTokens: 39, outputTokens: 36, cacheReadTokens: 2688, cacheWriteTokens: 0, totalTokens: 2763, reasoningTokens: 33 });
  assert.deepEqual(attempt.usage, { input: 39, output: 36, cacheRead: 2688, cacheWrite: 0, reasoning: 33, total: 2763 });
  assert.equal(metrics.cacheHitRate, 2688 / 2727);
  assert.equal(totals.cacheHitRate, 2688 / 2727);
  assert.equal(totals.totalTokens, 2763);
});

test("Trae distinguishes explicit cache miss from missing cache counters", async () => {
  const miss = await record({ prompt_tokens: 2727, completion_tokens: 51, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(miss.usage.cacheReadTokens, 0);
  assert.equal(miss.attempt.usage.cacheRead, 0);
  assert.equal(miss.totals.cacheHitRate, 0);
  const unknown = await record({ prompt_tokens: 80, completion_tokens: 20 });
  assert.equal(unknown.usage.cacheReadTokens, undefined);
  assert.equal(unknown.attempt.usage.cacheRead, undefined);
  assert.equal(unknown.attempt.usage.input, 80);
  assert.equal(unknown.totals.cacheHitRate, null);
  assert.equal(unknown.totals.cacheCoverage, 0);
});

test("Trae cache writes stay separate and malformed cache values stay unknown", async () => {
  const written = await record({ prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 });
  assert.equal(written.usage.inputTokens, 50);
  assert.equal(written.attempt.usage.cacheWrite, 10);
  const invalid = await record({ prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: -1, cache_creation_input_tokens: "10" });
  assert.equal(invalid.usage.cacheReadTokens, undefined);
  assert.equal(invalid.usage.cacheWriteTokens, undefined);
  assert.equal(invalid.usage.inputTokens, 80);
});
