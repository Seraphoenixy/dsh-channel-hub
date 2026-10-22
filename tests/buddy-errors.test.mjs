import test from "node:test";
import assert from "node:assert/strict";
import { BuddyAdapter } from "../vendor/ofm/src/buddy-adapter.ts";
import { CODEBUDDY, WORKBUDDY } from "../vendor/ofm/src/product.ts";
import { rewriteTencentContentFingerprints } from "../vendor/ofm/src/openai-gateway/tencent-fingerprint.ts";

const guiFirst = "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.";
const guiSecond = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.';
const guiPair = guiFirst + " " + guiSecond;
const guiSplit = guiFirst + "\n\n" + guiSecond;

test("GUI rule is exact, idempotent and restricted to Buddy CN", () => {
  assert.equal(rewriteTencentContentFingerprints(guiPair, "buddy"), guiSplit);
  assert.equal(rewriteTencentContentFingerprints(guiSplit, "buddy"), guiSplit);
  for (const provider of ["workbuddy", "codearts", "channel-hub/buddy"])
    assert.equal(rewriteTencentContentFingerprints(guiPair, provider), guiPair);
  const unrelated = guiPair.replace("runtime context", "request context");
  assert.equal(rewriteTencentContentFingerprints(unrelated, "buddy"), unrelated);
});

for (const product of [CODEBUDDY, WORKBUDDY]) {
  test(`${product.id}: GUI fingerprint covers both system inputs and preserves user/tool content`, async () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: guiPair }] },
      { role: "user", content: [{ type: "text", text: guiPair }] },
      { role: "assistant", content: [{ type: "tool-call", id: "gui-call", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "gui-call", content: [{ type: "text", text: guiPair }] },
    ];
    const identity = "You are an AI agent powered by DeepSeek Harness.";
    const options = { model: "test-model", system: identity + "\n\n" + guiPair + "\nKeep this suffix.", messages, tools: [] };
    const before = structuredClone(options);
    let calls = 0;
    const adapter = new BuddyAdapter({
      product, credentialRef: "SYNTHETIC_BUDDY",
      resolveCredential: async () => ({ access_token: "synthetic", domain: product.apiDomain }),
      refresh: async () => { throw Error("Unexpected refresh"); },
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        const expected = product.id === "buddy" ? guiSplit : guiPair;
        assert.equal(body.messages[0].content, "You are an AI agent running in DeepSeek Harness.\n\n" + expected + "\nKeep this suffix.");
        assert.equal(body.messages[1].content, expected);
        assert.equal(body.messages[2].content, guiPair);
        assert.equal(body.messages[4].role, "tool");
        assert.equal(body.messages[4].content, guiPair);
        return new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    for await (const _ of adapter.stream(options)) {}
    assert.equal(calls, 1);
    assert.deepEqual(options, before);
  });
  test(`${product.id}: standalone system and message systems are rewritten together`, async () => {
    const original = "You are an AI agent powered by DeepSeek Harness.";
    const system = original + "\nKeep these instructions.";
    const messages = [
      { role: "system", content: [{ type: "text", text: "Main branch (you will usually use this for PRs): main" }] },
      { role: "user", content: [{ type: "text", text: original }] },
    ];
    const before = structuredClone(messages);
    let calls = 0;
    const adapter = new BuddyAdapter({
      product,
      credentialRef: "SYNTHETIC_BUDDY",
      resolveCredential: async () => ({ access_token: "synthetic", domain: product.apiDomain }),
      refresh: async () => { throw Error("Unexpected refresh"); },
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.deepEqual(body.messages, [
          { role: "system", content: "You are an AI agent running in DeepSeek Harness.\nKeep these instructions." },
          { role: "system", content: "Main branch (PRs usually go here): main" },
          { role: "user", content: original },
        ]);
        return new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    const options = { model: "test-model", system, messages, tools: [] };
    for await (const _ of adapter.stream(options)) {}
    assert.equal(calls, 1);
    assert.equal(options.system, system);
    assert.deepEqual(messages, before);
  });
  test(`${product.id}: direct requests rewrite known system fingerprint only`, async () => {
    const original = "Main branch (you will usually use this for PRs): master";
    const messages = [
      { role: "system", content: [{ type: "text", text: "Neutral system" }] },
      { role: "system", content: [{ type: "text", text: original.toUpperCase() }] },
      { role: "user", content: [{ type: "text", text: original }] },
    ];
    let calls = 0;
    const adapter = new BuddyAdapter({
      product,
      credentialRef: "SYNTHETIC_BUDDY",
      resolveCredential: async () => ({ access_token: "synthetic", domain: product.apiDomain }),
      refresh: async () => { throw Error("Unexpected refresh"); },
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.equal(body.messages[0].content, "Neutral system");
        assert.equal(body.messages[1].content, "Main branch (PRs usually go here): MASTER");
        assert.equal(body.messages[2].content, original);
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    for await (const _ of adapter.stream({ model: "test-model", messages, tools: [] })) {}
    assert.equal(calls, 1);
    assert.equal(messages[1].content[0].text, original.toUpperCase());
  });
  test(`${product.id}: Harness identity is rewritten without changing user/tool text`, async () => {
    const original = "You are an AI agent powered by DeepSeek Harness.";
    const messages = [
      { role: "system", content: [{ type: "text", text: original + "\nKeep all other instructions." }] },
      { role: "user", content: [{ type: "text", text: original }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: original }] },
    ];
    const before = structuredClone(messages);
    let calls = 0;
    const adapter = new BuddyAdapter({
      product,
      credentialRef: "SYNTHETIC_BUDDY",
      resolveCredential: async () => ({ access_token: "synthetic", domain: product.apiDomain }),
      refresh: async () => { throw Error("Unexpected refresh"); },
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.equal(body.messages[0].content, "You are an AI agent running in DeepSeek Harness.\nKeep all other instructions.");
        assert.equal(body.messages[1].content, original);
        assert.equal(body.messages[2].tool_calls[0].id, "call-1");
        assert.equal(body.messages[3].role, "tool");
        assert.equal(body.messages[3].content, original);
        return new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    for await (const _ of adapter.stream({ model: "test-model", messages, tools: [] })) {}
    assert.equal(calls, 1);
    assert.deepEqual(messages, before);
  });
}
