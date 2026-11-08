import test from "node:test";
import assert from "node:assert/strict";
import { fetchQoderUserNickname } from "../vendor/ofm/src/qoder.ts";
import { QODER_CN } from "../vendor/ofm/src/qoder-product.ts";
import { syncQoderAccountName } from "../src/drivers/qoder-identity.ts";
import { convertLegacy } from "../src/migration.ts";

const credential = { access_token: "access", security_oauth_token: "session", machine_id: "existing-device", uid: "user" };

test(`${QODER_CN.id} userinfo uses its own region, session token and username fallback`, async () => {
  const name = await fetchQoderUserNickname(credential, QODER_CN, async (url, init) => {
    assert.equal(url, QODER_CN.openApiBase + "/api/v1/userinfo");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer session");
    assert.ok(init?.signal);
    return Response.json({ name: "  ", username: " Alice " });
  });
  assert.equal(name, "Alice");
});

test("existing Qoder generated label is repaired without writing credentials", async () => {
  let account = { id: "qodercn-1", provider: "qodercn", credentialRef: "REF_1", nickname: "qodercn-1" };
  const before = structuredClone(credential);
  await syncQoderAccountName({
    account, credential, product: QODER_CN,
    getAccount: () => account, readCredential: async () => credential,
    updateAccount: async (id, patch) => { assert.equal(id, "qodercn-1"); account = { ...account, ...patch }; },
    fetcher: async () => Response.json({ name: "Alice" }),
  });
  assert.equal(account.nickname, "Alice");
  assert.deepEqual(credential, before);
});

test("Qoder name repair respects custom names and does not require a remote call for saved nickname", async () => {
  let account = { id: "qodercn-1", provider: "qodercn", credentialRef: "REF_1", nickname: "My account" };
  const options = {
    account, credential, product: QODER_CN,
    getAccount: () => account, readCredential: async () => credential,
    updateAccount: async (_id: string, patch: { nickname: string }) => { account = { ...account, ...patch }; },
    fetcher: async () => { throw Error("Remote call forbidden"); },
  };
  await syncQoderAccountName(options);
  assert.equal(account.nickname, "My account");
  account = { ...account, nickname: account.id };
  const saved = { ...credential, nickname: " Saved name " };
  await syncQoderAccountName({ ...options, account, credential: saved, readCredential: async () => saved });
  assert.equal(account.nickname, "Saved name");
});

test("failed userinfo and concurrent Qoder login/rename do not replace account identity", async () => {
  for (const change of ["failure", "token", "rename", "remove", "ref"]) {
    let account: any = { id: "qodercn-1", provider: "qodercn", credentialRef: "REF_1", nickname: "qodercn-1" };
    let latest = credential;
    let writes = 0;
    await syncQoderAccountName({
      account, credential, product: QODER_CN,
      getAccount: () => account, readCredential: async () => latest,
      updateAccount: async () => { writes++; },
      fetcher: async () => {
        if (change === "failure") return new Response("", { status: 401 });
        if (change === "token") latest = { ...credential, access_token: "new-login" };
        if (change === "rename") account = { ...account, nickname: "Custom" };
        if (change === "remove") account = undefined;
        if (change === "ref") account = { ...account, credentialRef: "REF_2" };
        return Response.json({ username: "Stale response" });
      },
    });
    assert.equal(writes, 0, change);
  }
});

test("legacy Qoder import preserves nickname or username when name is empty", () => {
  for (const fields of [{ nickname: "Saved", name: "" }, { name: " ", username: "Saved" }]) {
    const result = convertLegacy("qodercn", { token: "session", uid: "user", machineId: "existing", ...fields });
    assert.equal(result?.credential.nickname, "Saved");
    assert.equal(result?.credential.machine_id, "existing");
  }
});

test("legacy Qoder international sessions are no longer importable", () => {
  const result = convertLegacy("qoder", { token: "session", uid: "user", machineId: "existing" });
  assert.equal(result, undefined);
});
