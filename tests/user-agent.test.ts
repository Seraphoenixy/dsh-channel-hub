import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_USER_AGENT, withChannelUserAgent } from "../src/drivers/user-agent.ts";

test("channel transport replaces DSH attribution and supplies missing UA", async () => {
  for (const ua of [undefined, "", "deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)"]) {
    const headers = new Headers({ Authorization: "fixture", "x-sdk-date": "fixture-date" });
    if (ua !== undefined) headers.set("user-agent", ua);
    const init = { method: "POST", body: "fixture-body", headers, signal: new AbortController().signal };
    const transport = withChannelUserAgent(async (input, sent) => {
      assert.equal(input, "https://example.invalid/inference");
      const actual = new Headers(sent?.headers);
      assert.equal(actual.get("user-agent"), CHANNEL_USER_AGENT);
      assert.equal(actual.get("authorization"), "fixture");
      assert.equal(actual.get("x-sdk-date"), "fixture-date");
      assert.equal(sent?.body, init.body);
      assert.equal(sent?.signal, init.signal);
      return new Response();
    });
    await transport("https://example.invalid/inference", init);
    assert.equal(headers.get("user-agent"), ua ?? null);
  }
});

test("OFM product UA is forwarded unchanged", async () => {
  for (const ua of ["Qoder/1.0.0", "CodeBuddyIDE/1.0", "antigravity/4.3.0 (cmdc-pak)", "custom-client/2"]) {
    const init = { headers: { "User-Agent": ua } };
    await withChannelUserAgent(async (_, sent) => {
      assert.equal(sent, init);
      return new Response();
    })("https://example.invalid", init);
  }
});

test("Request headers and body survive UA replacement and init headers take precedence", async () => {
  const request = new Request("https://example.invalid", {
    method: "POST", body: "request-body", headers: { Authorization: "fixture", "User-Agent": "deepseek-harness/1" },
  });
  await withChannelUserAgent(async (input, init) => {
    const sent = new Request(input, init);
    assert.equal(sent.headers.get("user-agent"), CHANNEL_USER_AGENT);
    assert.equal(sent.headers.get("authorization"), "fixture");
    assert.equal(await sent.text(), "request-body");
    return new Response();
  })(request);
  await withChannelUserAgent(async (_, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), CHANNEL_USER_AGENT);
    assert.equal(headers.get("authorization"), null);
    return new Response();
  })(request, { headers: { "x-custom": "override" } });
});
