import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertLegacy, MigrationService } from "../src/migration.ts";
test("legacy WorkBuddy envelope converts and preserves refresh and region", () => {
  const value = convertLegacy("workbuddy", {
    version: 1,
    credential: {
      accessToken: "test",
      refreshToken: "refresh",
      expiresAtMs: 1790000000000,
      uid: "u",
      domain: "www.workbuddy.ai",
    },
  })!;
  assert.equal(value.credential.access_token, "test");
  assert.equal(value.credential.refresh_token, "refresh");
  assert.equal(value.expiresAt, 1790000000000);
  assert.equal(value.refreshable, true);
  assert.equal(value.provider, "workbuddy");
});
test("CodeBuddy history normalizes to buddy", () => {
  const value = convertLegacy("buddy", {
    credential: {
      accessToken: "test",
      refreshToken: "refresh",
      domain: "www.codebuddy.cn",
    },
  })!;
  assert.equal(value.provider, "buddy");
  assert.equal(value.credential.domain, "www.codebuddy.cn");
});
test("existing Qoder session without machine identity requires login", () => {
  assert.equal(
    convertLegacy("qoder", {
      token: "test",
      uid: "u",
      refreshToken: "refresh",
    }),
    undefined,
  );
});
test("legacy Trae credentials import into Trae CN IDE with their device", () => {
  const value = convertLegacy("trae", {
    token: "test",
    userId: "u",
    refreshToken: "refresh",
    deviceId: "existing",
  })!;
  assert.equal(value.provider, "trae");
  assert.equal(value.refreshable, true);
  assert.equal(value.credential.device_id, "existing");
});
test("migration maps CN WorkBuddy slots onto the shared buddy channel", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "chub-buddy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "connect-auth"), { recursive: true });
  writeFileSync(
    join(home, "connect-channels.json"),
    JSON.stringify([
      { id: "workbuddy1", kind: "workbuddy", region: "cn" },
      { id: "workbuddy4", kind: "workbuddy", region: "global" },
    ]),
  );
  writeFileSync(
    join(home, "connect-auth", "workbuddy1.json"),
    JSON.stringify({
      credential: {
        accessToken: "cn",
        refreshToken: "refresh",
        domain: "www.codebuddy.cn",
      },
    }),
  );
  writeFileSync(
    join(home, "connect-auth", "workbuddy4.json"),
    JSON.stringify({
      credential: {
        accessToken: "global",
        refreshToken: "refresh",
        domain: "www.workbuddy.ai",
      },
    }),
  );
  const service = new MigrationService(
    home,
    { async resolve() {} },
    { async set() {} },
    {},
    { async call() {} } as any,
  );
  const preview = await service.preview();
  assert.deepEqual(
    preview.map((p: any) => [p.id, p.provider]),
    [
      ["workbuddy1", "buddy"],
      ["workbuddy4", "workbuddy"],
    ],
  );
});
test("migration is explicit, repeatable, read-only to sources and does not overwrite fresh credentials", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "chub-import-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "channel-pack"), { recursive: true });
  const source = join(home, "channel-pack", "state.json");
  writeFileSync(
    source,
    JSON.stringify({
      accounts: [
        {
          id: "old",
          provider: "qoder",
          nickname: "Q",
          credentialRef: "OLD",
          enabled: true,
          refreshable: true,
        },
      ],
      disabledModels: { qoder: { hidden: true } },
    }),
  );
  const before = readFileSync(source);
  const values = new Map<string, unknown>();
  const credentials = new Map<string, string>();
  const accounts = new Map<string, any>();
  let disabled = new Set(["existing"]);
  const store = {
    async call<T = any>(
      method: string,
      key: string,
      value?: unknown,
    ): Promise<T> {
      if (method === "set") values.set(key, value);
      return values.get(key) as T;
    },
  };
  const pool = {
    findAccount: (id: string) => accounts.get(id),
    async addAccount(a: any) {
      accounts.set(a.id, a);
    },
    disabledModelsFor: () => disabled,
    async setModelsDisabled(_p: string, ids: string[]) {
      disabled = new Set(ids);
    },
  };
  const service = new MigrationService(
    home,
    {
      async resolve() {
        return { value: '{"access_token":"fixture"}' };
      },
    },
    {
      async set(ref: string, value: string) {
        credentials.set(ref, value);
      },
    },
    pool,
    store,
  );
  const preview = await service.preview();
  assert.equal(preview.length, 1);
  assert.equal(accounts.size, 0);
  assert.equal(JSON.stringify(preview).includes("fixture"), false);
  await service.importAll(new Set(["qoder"]));
  assert.equal(accounts.size, 1);
  const ref = [...credentials.keys()][0];
  credentials.set(ref, "new-login");
  values.clear();
  await service.importAll(new Set(["qoder"]));
  assert.equal(credentials.get(ref), "new-login");
  assert.deepEqual(disabled, new Set(["existing", "hidden"]));
  assert.deepEqual(readFileSync(source), before);
});
