import test from "node:test";
import assert from "node:assert/strict";
import { consumeOpenAiSse } from "../vendor/ofm/src/openai-compat.ts";
import { unwrapQoderEnvelopeStream } from "../vendor/ofm/src/qoder-envelope.ts";

/**
 * 实测形态（2026-10-20 只读探针，真实账号）：Qoder CN 的额度与排队错误
 * **都以 HTTP 200 + 双层 SSE 信封**下发，`statusCodeValue:403` 藏在 `body` 里。
 *
 * 这里用同一份真实帧形状断言三件事：
 * 1. 额度错误必须归类为 `QUOTA_EXCEEDED`（**不可重试**）—— 落到 `SERVER`
 *    会被 harness 白重试 5 次（约 15.5 秒），而「今日次数用完」是确定性错误；
 * 2. 文案必须是可读中文，原始英文保留在括号里便于对照上游；
 * 3. 排队（10605）不能被误归成额度用尽 —— 它是可等待的。
 *
 * 用 `.mjs` 而非 `.ts`：`tsconfig` 排除了 `vendor/`，从 TS 里 import vendor
 * 会把整张 vendor 类型图拉进 typecheck（缺 dsh-llm 声明即报 TS7016）。
 */
function envelope(body, status = 403) {
  const frame = JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body,
    statusCodeValue: status,
    statusCode: "FORBIDDEN",
  });
  return new Response(`data:${frame}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function failureOf(response) {
  const inner = consumeOpenAiSse(
    unwrapQoderEnvelopeStream(response, "qoder"),
    {},
    { label: "qoder" },
  );
  try {
    for await (const _ of inner) {
      // 错误帧不会产出 chunk；这里只是把生成器跑到底。
    }
  } catch (e) {
    return e;
  }
  return undefined;
}

test("Qoder daily-count rejection is terminal and explained in Chinese", async () => {
  const error = await failureOf(
    envelope('{"code":"110","message":"Billing daily count exceeded"}'),
  );
  assert.ok(error, "额度错误必须抛出，不能被静默当成正常结束");
  assert.equal(error.code, "QUOTA_EXCEEDED");
  assert.match(error.message, /今日对话次数已达上限/);
  // 原始英文保留，便于对照上游文档与工单。
  assert.match(error.message, /Billing daily count exceeded/);
});

test("Qoder queue rejection stays distinguishable from quota", async () => {
  const queued = JSON.stringify({
    code: "10605",
    message: JSON.stringify({
      isQueued: true,
      modelKey: "dfmodel",
      queueCount: 2860,
      queueType: "p3",
      retryAfterSeconds: 30,
      serviceAvailable: true,
      subCode: "CALL_COUNT_LIMIT",
      waitTime: 173,
    }),
    subCode: "CALL_COUNT_LIMIT",
  });
  const error = await failureOf(envelope(queued));
  assert.ok(error, "排队错误必须抛出");
  // 排队是可等待的，不能被归成额度用尽（否则用户会被误导去换账号）。
  assert.notEqual(error.code, "QUOTA_EXCEEDED");
  assert.match(String(error.message), /排队|10605|isQueued/i);
});
