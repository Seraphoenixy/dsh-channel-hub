import test from "node:test";
import assert from "node:assert/strict";
import { browserCommand, authorizationLink } from "../src/host/browser.ts";

test("Windows opens OAuth URL as one shell-free argument with all parameters", () => {
  const url =
    "https://example.com/auth?state=a&redirect_uri=http%3A%2F%2Flocalhost%3A1234&code_challenge=b";
  assert.deepEqual(browserCommand(url, "win32"), [
    "rundll32.exe",
    ["url.dll,FileProtocolHandler", url],
  ]);
  assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
  assert.throws(() => browserCommand("file:///test"));
  assert.throws(() => browserCommand("https://example.com/\n"));
});

test("authorization launches once and retains the same link when launching fails", async () => {
  const url = "https://example.com/auth?state=original";
  const calls: string[] = [];
  assert.deepEqual(
    await authorizationLink(url, async (value) => {
      calls.push(value);
    }),
    { loginUrl: url, browserOpened: true },
  );
  assert.deepEqual(calls, [url]);
  assert.deepEqual(
    await authorizationLink(url, async () => {
      throw Error("missing browser");
    }),
    { loginUrl: url, browserOpened: false },
  );
});
