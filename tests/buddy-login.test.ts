import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCredential,
  credentialExpiresAtMs,
  parseAccountData,
  parseTokenData,
} from "../vendor/ofm/src/buddy.ts";

/**
 * International WorkBuddy login regression.
 *
 * The live `auth/token` response is relative (`expiresIn`, seconds). `expiresIn: 0`
 * means "backend did not provide a lifetime" — it must not be converted to
 * `Date.now()`, which made a freshly signed-in account look expired at once.
 * The nickname comes from `login/account` (or the JWT claim when the account
 * response omits it), never from the generated account id.
 */
function credentialOf(data: Record<string, unknown>, account: Record<string, unknown>) {
  return buildCredential(
    parseTokenData(data),
    parseAccountData(account),
  );
}

test("WorkBuddy login stores the account nickname and a positive expiry", () => {
  const before = Date.now();
  const credential = credentialOf(
    {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresIn: 3600,
      domain: "www.workbuddy.ai",
    },
    { uid: "uid-1", nickname: "Alice", enterpriseId: "" },
  );
  assert.equal(credential.nickname, "Alice");
  assert.equal(credential.user_id, "uid-1");
  assert.ok(Number(credential.expires_at) >= before + 3500_000);
  assert.ok((credentialExpiresAtMs(credential) ?? 0) >= before + 3500_000);
});

test("WorkBuddy ignores a zero absolute expiry and keeps the relative lifetime", () => {
  const before = Date.now();
  const credential = credentialOf(
    {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresAt: 0,
      refreshExpiresAt: 0,
      expiresIn: 3600,
      refreshExpiresIn: 7200,
      domain: "www.workbuddy.ai",
    },
    { uid: "uid-1", nickname: "Alice", enterpriseId: "" },
  );
  assert.ok(Number(credential.expires_at) >= before + 3500_000);
  assert.ok(Number(credential.refresh_expires_at) >= before + 7100_000);
});

test("WorkBuddy expiresIn=0 stays unknown instead of expiring immediately", () => {
  const credential = credentialOf(
    {
      accessToken: "opaque-access-token",
      refreshToken: "opaque-refresh-token",
      expiresIn: 0,
      domain: "www.workbuddy.ai",
    },
    { uid: "uid-1", nickname: "Alice", enterpriseId: "" },
  );
  assert.equal(credential.nickname, "Alice");
  assert.equal(credential.expires_at, "");
  assert.equal(credentialExpiresAtMs(credential), undefined);
});
