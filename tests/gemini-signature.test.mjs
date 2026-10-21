import test from "node:test";
import assert from "node:assert/strict";
import {
  translateGeminiRequest,
  translateGeminiResponse,
} from "../vendor/ofm/src/gemini-messages.ts";
import { GEMINI_SKIP_SIGNATURE } from "../vendor/ofm/src/gemini.ts";
import { geminiModelSpec } from "../vendor/ofm/src/gemini.ts";

/**
 * Gemini `thoughtSignature` 的往返（真实报障，2026-10-21）。
 *
 * 报障原文：
 * `Function call is missing a thought_signature in functionCall parts. This is
 * required for tools to work correctly ... function call default_api:grep,
 * position 6.`
 *
 * 三条必须成立的行为：
 * 1. 上游把签名挂在 **thought part** 上时也要收下来（不是只有 functionCall 上的）；
 * 2. 当前轮缺失真签名时发**哨兵值**跳过校验，而不是干脆不带（那样必然 400）；
 * 3. 历史轮不补哨兵（上游只校验当前轮，补假签名会掩盖真实缓存命中）。
 *
 * 夹具全部合成，不联网、不读真实凭据。
 */

const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantToolCall = (id, name, args) => ({
  role: "assistant",
  content: [
    { type: "tool-call", id, name, arguments: JSON.stringify(args) },
  ],
});
/**
 * DSH 0.1.7 的一等工具结果消息：`toolCallId` 在**顶层**，content 是块数组。
 * ⚠️ 写成块内的 `toolCallId` 会被 `normalizeHarnessMessages` 当成旧形态，
 * 配对 `allResultIds` 就查不到它 → assistant 的 tool-call 全被剔除。
 */
const toolResult = (toolCallId, text) => ({
  role: "tool",
  toolCallId,
  content: [{ type: "text", text }],
});

const translate = (messages, lookupSignature) =>
  translateGeminiRequest({
    modelId: "gemini-3.8-flash",
    spec: geminiModelSpec("gemini-3.8-flash", "medium"),
    messages,
    requestId: "req-1",
    ...(lookupSignature === undefined ? {} : { lookupSignature }),
  });

const signatureOf = (envelope, index) =>
  envelope.request.contents[index]?.parts?.[0]?.thoughtSignature;

test("a signature carried on a thought part is attributed to the next functionCall", () => {
  // 上游实际形态：签名在 thought part 上，紧随其后的 functionCall 自己没有签名。
  const calls = [];
  translateGeminiResponse({
    response: {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "I should grep.", thoughtSignature: "SIG-A" },
              { functionCall: { name: "default_api:grep", args: { pattern: "x" } } },
            ],
          },
        },
      ],
    },
    onSignature: (name, argsJson, signature) =>
      calls.push([name, JSON.parse(argsJson), signature]),
  });
  assert.deepEqual(calls, [
    ["default_api:grep", { pattern: "x" }, "SIG-A"],
  ]);
});

test("a signature on the functionCall part itself still wins", () => {
  const calls = [];
  translateGeminiResponse({
    response: {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "thinking", thoughtSignature: "SIG-OLD" },
              {
                functionCall: { name: "grep", args: { pattern: "y" } },
                thoughtSignature: "SIG-NEW",
              },
            ],
          },
        },
      ],
    },
    onSignature: (name, _argsJson, signature) => calls.push([name, signature]),
  });
  assert.deepEqual(calls, [["grep", "SIG-NEW"]]);
});

test("the current turn sends the sentinel when no cached signature is available", () => {
  // 没有签名缓存：当前轮首个 functionCall 必须带哨兵，否则上游 400。
  //
  // 这正是真实时序：模型调了 `grep`，DSH 把结果回填后再请求一次 —— 此时
  // 历史是 [用户提问, 模型 tool-call, 工具结果]，最后一个**带文本的 user**
  // 仍是开头的提问，故该 tool-call 属于**当前轮**。
  const envelope = translate(
    [
      userText("search"),
      assistantToolCall("c1", "grep", { pattern: "x" }),
      toolResult("c1", "hit"),
    ],
    () => undefined,
  );
  assert.equal(signatureOf(envelope, 1), GEMINI_SKIP_SIGNATURE);
});

test("the sentinel value is the documented literal, not its base64", () => {
  assert.equal(GEMINI_SKIP_SIGNATURE, "skip_thought_signature_validator");
});

test("a cached signature is sent verbatim and takes priority over the sentinel", () => {
  const envelope = translate(
    [
      userText("search"),
      assistantToolCall("c1", "grep", { pattern: "x" }),
      toolResult("c1", "hit"),
    ],
    () => "CACHED-SIG",
  );
  assert.equal(signatureOf(envelope, 1), "CACHED-SIG");
});

test("only the first functionCall of a step carries a signature", () => {
  // 并行调用：上游只把签名挂在第一个 part 上，后续 part 不带。
  const parallel = translate(
    [
      userText("search"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "c1", name: "grep", arguments: '{"pattern":"x"}' },
          { type: "tool-call", id: "c2", name: "read", arguments: '{"path":"y"}' },
        ],
      },
      toolResult("c1", "hit"),
      toolResult("c2", "body"),
    ],
    () => "CACHED-SIG",
  );
  assert.equal(signatureOf(parallel, 1), "CACHED-SIG");
  assert.equal(
    parallel.request.contents[1].parts[1].thoughtSignature,
    undefined,
    "subsequent parallel calls must not repeat the signature",
  );
});

test("earlier turns never get an invented sentinel", () => {
  // 上一轮（最后一条带文本的 user 之前）的 functionCall 不参与校验，
  // 也不该被补假签名 —— 那会掩盖真实缓存命中。
  const envelope = translate(
    [
      userText("first turn"),
      assistantToolCall("c1", "grep", { pattern: "old" }),
      toolResult("c1", "old result"),
      userText("second turn"),
      assistantToolCall("c2", "read", { path: "new" }),
      toolResult("c2", "new result"),
    ],
    () => undefined,
  );
  const firstTurnCall = envelope.request.contents[1].parts[0];
  const currentTurnCall = envelope.request.contents[4].parts[0];
  assert.equal(
    firstTurnCall.thoughtSignature,
    undefined,
    "historical turns are not validated and must not carry an invented signature",
  );
  assert.equal(
    currentTurnCall.thoughtSignature,
    GEMINI_SKIP_SIGNATURE,
    "the call in the current turn must still satisfy validation",
  );
});

test("token counts stay separate from the signature path", () => {
  // 回归护栏：签名改动不得掺进 `generationConfig`。
  const envelope = translate([userText("hi")], () => undefined);
  assert.deepEqual(Object.keys(envelope.request.generationConfig).sort(), [
    "maxOutputTokens",
    "thinkingConfig",
  ]);
});
