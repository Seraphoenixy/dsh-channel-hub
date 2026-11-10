import test from "node:test";
import assert from "node:assert/strict";
import { TraeAdapter } from "../vendor/ofm/src/trae-adapter.ts";
import { Observer } from "../src/core/observer.ts";
import { LedgerDatabase } from "../src/storage/database.ts";

/**
 * 一条合成帧。
 *
 * `metadata` 的四种取值对应上游的四种事实（这四者含义不同，见
 * `trae-adapter.ts` 的 `cachePoolAssigned`）：
 * - `undefined`：整个流里没有 `metadata` 事件（老版本上游）；
 * - `"absent"`：有 `metadata` 事件但没有 `prompt_cache_pool_record` 这个键；
 * - `null`：有该键且为 `null` —— 上游明说本次没挂缓存池；
 * - 其他值：非空记录 —— 本次挂了缓存池，计数是测量值。
 */
const frame = (usage, metadata) => ({ usage, metadata });

/**
 * Trae 一次真实响应里除 `output` / `token_usage` / `done` 之外的诊断帧
 * （2026-11-02 抓帧原样，见 `.cache/trae-frames-audit.mjs`）。
 *
 * ⚠️ 它们**必须**被忽略而不是被当成错误或用量：`request_wait_in_queue` 带
 * `message` 但没有 `code`，`extra_info` 带 `content` / `input_token`（那个数是
 * `content` 的 token 数，不是 prompt 的未命中量）。观察者的错误判据要求
 * `code` 存在，用量判据要求 `usage` 形状 —— 这条测试把两个前提都锁定，
 * 否则上游给诊断帧加个 `code` 就会把整条请求误记成失败。
 */
const DIAGNOSTIC_FRAMES =
  'event: progress_notice\ndata: "Processing_1"\n\n' +
  'event: queue_begin\ndata: {"queue_id":"q","queue_type":1,"is_async":false,"request_uuid":"u"}\n\n' +
  'event: request_wait_in_queue\ndata: {"position":3,"message":"waiting in queue","queue_id":"q","is_async":false,"request_uuid":"u"}\n\n' +
  'event: extra_info\ndata: ' + JSON.stringify({
    model: "glm-5.3-flash", version: 1,
    content: '{"reasoning_content":"synthetic"}', input_token: 12, expire_time: 2739688909826,
  }) + "\n\n" +
  'event: timing_cost\ndata: ' + JSON.stringify({
    name: "llm_raw_chat_v2", queue_timing: 20253, first_sse_event_time: 3085, provider_model_name: "glm-5.3-flash",
  }) + "\n\n";

/**
 * 用真实适配器 + 观察者 + 账本跑一次（或多次）合成上游请求。
 *
 * 每个元素各算一次请求；`eventOrder` 可把 `metadata` 放到 `token_usage` 之后，
 * 用来锁定「诊断帧来晚了就按未知处理」的保守语义。
 */
async function record(rawUsage, options = {}) {
  const frames = (Array.isArray(rawUsage) ? rawUsage : [rawUsage]).map((f) =>
    f && f.usage ? f : frame(f));
  const db = new LedgerDatabase(":memory:");
  const observer = new Observer({ async call(method, ...args) { return db[method](...args); } }, { warn() {} });
  let turn = 0;
  const events = (f) => {
    const output = 'event: output\ndata: {"response":"OK"}\n\n';
    const done = 'event: done\ndata: {"finish_reason":"stop"}\n\n';
    const usage = "event: token_usage\ndata: " + JSON.stringify(f.usage) + "\n\n";
    const metadata = f.metadata === undefined
      ? ""
      : "event: metadata\ndata: " + JSON.stringify({
          model: "",
          ...(f.metadata === "absent" ? {} : { prompt_cache_pool_record: f.metadata }),
        }) + "\n\n";
    const diagnostics = options.diagnostics === true ? DIAGNOSTIC_FRAMES : "";
    return options.metadataAfterUsage === true
      ? output + usage + metadata + done
      : output + diagnostics + metadata + usage + done;
  };
  const adapter = new TraeAdapter({
    credentialRef: "SYNTHETIC_TRAE",
    resolveCredential: async () => {
      observer.bindAccount("synthetic-trae");
      return { access_token: "synthetic", machine_id: "synthetic-machine", device_id: "synthetic-device" };
    },
    refresh: async () => { throw Error("Unexpected refresh"); },
    fetchRemoteModels: async () => [{ id: "glm-5.3-flash", name: "Synthetic model" }],
    // 每次调用都要新建 Response —— body 只能被消费一次，复用会让第 2 次请求拿到空流。
    fetchImpl: observer.fetcher(async () => new Response(
      events(frames[Math.min(turn, frames.length - 1)]),
      { headers: { "content-type": "text/event-stream" } },
    )),
  });
  const usages = [];
  try {
    for (const _ of frames) {
      for await (const chunk of observer.stream("trae", "glm-5.3-flash", (signal) => adapter.stream({
        model: "glm-5.3-flash", signal, tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }))) {
        if (chunk.type === "usage") usages.push(chunk.usage);
      }
      turn++;
    }
    const rows = db.list().items;
    assert.equal(rows.length, frames.length);
    for (const row of rows) assert.equal(row.outcome, "success");
    const totals = db.stats().totals;
    return {
      usage: usages[0],
      usages,
      attempt: rows[0].attempts[0],
      metrics: rows[0].metrics,
      totals,
    };
  } finally { await observer.close(); db.close(); }
}

/** 2026-10-27 之后现场帧的字段（两个计数与全部 `*_total` 都是 0）。 */
const zeroed = (prompt = 18955, completion = 79) => ({
  name: "", prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 76,
  prompt_tokens_total: 0, completion_tokens_total: 0, total_tokens_total: 0,
  cache_creation_input_tokens_total: 0, cache_read_input_tokens_total: 0, reasoning_tokens_total: 0,
  cluster: "normal_context",
});

test("Trae live-shaped cache hit reaches host usage and persistent ledger without double counting", async () => {
  const { usage, attempt, metrics, totals } = await record({
    prompt_tokens: 2727, completion_tokens: 36, total_tokens: 2763,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 2688, reasoning_tokens: 33,
    prompt_tokens_total: 0, cache_read_input_tokens_total: 0,
  });
  assert.deepEqual(usage, { inputTokens: 39, outputTokens: 36, cacheReadTokens: 2688, totalTokens: 2763, reasoningTokens: 33 });
  assert.deepEqual(attempt.usage, { input: 39, output: 36, cacheRead: 2688, reasoning: 33, total: 2763 });
  assert.equal(metrics.cacheHitRate, 2688 / 2727);
  assert.equal(totals.cacheHitRate, 2688 / 2727);
  assert.equal(totals.totalTokens, 2763);
});

test("a non-zero count is Trae's own word even when no cache pool was assigned", async () => {
  // 上游明说没挂池、却给了非零命中（含池记录口径变化后的形态）：真值优先。
  const { usage, totals } = await record(frame({
    prompt_tokens: 3000, completion_tokens: 10, cache_read_input_tokens: 2048,
  }, null));
  assert.equal(usage.cacheReadTokens, 2048);
  assert.equal(usage.inputTokens, 952);
  assert.equal(totals.cacheHitRate, 2048 / 3000);
});

test("Trae's post-2026-10-27 zeroed counters with no cache pool are unknown, not a 0% miss", async () => {
  // 现场原样（2026-11-02 实测，见 traeCacheCount 的注释）：两个缓存计数恒 0、
  // cluster 出现、`metadata.prompt_cache_pool_record` 为 null。此时 0 不是测量值。
  const zeroedPoolNull = await record(frame(zeroed(), null));
  assert.equal(zeroedPoolNull.usage.cacheReadTokens, undefined);
  assert.equal(zeroedPoolNull.usage.cacheWriteTokens, undefined);
  // 输入仍是全量 prompt：总 token 不能因「少算命中」而变小（否则自动压缩永不触发）。
  assert.equal(zeroedPoolNull.usage.inputTokens, 18955);
  assert.equal(zeroedPoolNull.usage.totalTokens, 19034);
  assert.equal(zeroedPoolNull.attempt.usage.cacheRead, undefined);
  assert.equal(zeroedPoolNull.attempt.usage.input, 18955);
  assert.equal(zeroedPoolNull.totals.cacheHitRate, null);
  assert.equal(zeroedPoolNull.totals.cacheCoverage, 0);
  assert.equal(zeroedPoolNull.totals.totalTokens, 19034);
  // 上游的「没挂池」声明要落在 attempt 上，界面才能把「—」补上原因。
  assert.equal(zeroedPoolNull.attempt.cachePool, null);
});

test("a pool-assigned zero is a real miss again, so 0% comes back by itself", async () => {
  // 上游恢复分配缓存池后，同样一帧 0 就是「本次确实没命中」—— 这条保证我们
  // 不会永久性地把真 0% 藏起来，无需再改代码。
  const assigned = await record(frame(zeroed(), { pool_id: "synthetic-pool" }));
  assert.equal(assigned.usage.cacheReadTokens, 0);
  assert.equal(assigned.usage.cacheWriteTokens, 0);
  assert.equal(assigned.usage.inputTokens, 18955);
  assert.equal(assigned.totals.cacheSamples, 1);
  assert.equal(assigned.totals.cacheHitRate, 0);
  assert.equal(assigned.totals.cacheCoverage, 1);
  assert.match(String(assigned.attempt.cachePool), /synthetic-pool/);
});

test("Trae: a frame that never names a cache pool stays unknown even with a metadata event", async () => {
  // 老版本上游：有 metadata 事件、但没有 prompt_cache_pool_record 键 ——
  // 「没有这套机制」不等于「明确没有池」，同样按未知处理。
  const absentKey = await record(frame(zeroed(), "absent"));
  assert.equal(absentKey.usage.cacheReadTokens, undefined);
  assert.equal(absentKey.totals.cacheHitRate, null);
  // 「没有这个键」不等于「明确没有池」：不能在界面上说「上游未分配缓存池」。
  assert.equal(absentKey.attempt.cachePool, undefined);
  const noEvent = await record(frame(zeroed()));
  assert.equal(noEvent.usage.cacheReadTokens, undefined);
  assert.equal(noEvent.totals.cacheHitRate, null);
});

test("Trae: a metadata frame that arrives after token_usage is handled conservatively", async () => {
  // 当前实测 metadata 早于 token_usage；若哪天反了，宁可显示未知，
  // 也不把「还没来得及读到池记录」的 0 当成未命中。
  const late = await record(frame(zeroed(), { pool_id: "synthetic-pool" }), { metadataAfterUsage: true });
  assert.equal(late.usage.cacheReadTokens, undefined);
  assert.equal(late.totals.cacheHitRate, null);
});

test("Trae reads DeepSeek and OpenAI cache field names, taking the largest", async () => {
  const deepseek = await record({ prompt_tokens: 3000, completion_tokens: 10, prompt_cache_hit_tokens: 2048, prompt_cache_miss_tokens: 952 });
  assert.equal(deepseek.usage.cacheReadTokens, 2048);
  assert.equal(deepseek.usage.inputTokens, 952);

  const openai = await record({
    prompt_tokens: 3000, completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 1024 },
  });
  assert.equal(openai.usage.cacheReadTokens, 1024);
  assert.equal(openai.usage.inputTokens, 1976);

  // 同一数值被多套命名镜像时不能重复计数；桩 0 不能遮住真值。
  const mirrored = await record({
    prompt_tokens: 3000, completion_tokens: 10,
    cache_read_input_tokens: 0, prompt_cache_hit_tokens: 2048,
    prompt_tokens_details: { cached_tokens: 2048 },
  });
  assert.equal(mirrored.usage.cacheReadTokens, 2048);
  assert.equal(mirrored.usage.inputTokens, 952);
});

test("Trae cache writes stay separate and malformed cache values stay unknown", async () => {
  const written = await record({ prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 });
  assert.equal(written.usage.inputTokens, 50);
  assert.equal(written.attempt.usage.cacheWrite, 10);
  // 写入非 0 时，读取的桩 0 不能被"顺带"采信。
  assert.equal(written.usage.cacheReadTokens, 20);
  const invalid = await record({ prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: -1, cache_creation_input_tokens: "10" });
  assert.equal(invalid.usage.cacheReadTokens, undefined);
  assert.equal(invalid.usage.cacheWriteTokens, undefined);
  assert.equal(invalid.usage.inputTokens, 80);
});

test("Trae's diagnostic frames are neither errors nor phantom usage", async () => {
  // 2026-11-02 抓帧审计：progress_notice / queue_* / extra_info / timing_cost 都在
  // 同一个流里。它们不能被观察者当成错误（那样每条请求都会记成失败），
  // extra_info 的 `input_token` 也不能被当成 prompt 的未命中量。
  const audited = await record(frame(zeroed(), null), { diagnostics: true });
  assert.equal(audited.attempt.outcome, "success");
  assert.equal(audited.attempt.error, undefined);
  assert.equal(audited.usage.inputTokens, 18955, "input_token from extra_info must not be mistaken for prompt input");
  assert.equal(audited.totals.reported, 1);
  assert.equal(audited.totals.cacheHitRate, null);
});

test("Trae: unknown samples leave the hit rate to the samples that did report", async () => {
  // 一个真命中 + 两个「上游没给」：命中率只按报过数的那个算，覆盖率如实下降。
  const mixed = await record([
    { prompt_tokens: 2727, completion_tokens: 36, cache_read_input_tokens: 2688, total_tokens: 2763 },
    frame(zeroed(), null),
    frame(zeroed(18960, 40), null),
  ]);
  assert.equal(mixed.totals.reported, 3);
  assert.equal(mixed.totals.cacheSamples, 1);
  assert.equal(mixed.totals.cacheHitTokens, 2688);
  assert.equal(mixed.totals.cacheInput, 2727);
  assert.equal(mixed.totals.cacheHitRate, 2688 / 2727);
  assert.equal(mixed.totals.cacheCoverage, 1 / 3);
});
