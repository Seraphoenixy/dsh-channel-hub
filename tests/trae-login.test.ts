import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TRAE } from "../vendor/ofm/src/trae-product.ts";
import type { TraeProduct } from "../vendor/ofm/src/trae-product.ts";
import {
  TRAE_EXCHANGE_PATH,
  TRAE_USER_INFO_PATH,
} from "../vendor/ofm/src/trae.ts";
import {
  buildTraeLoginURL,
  startTraeLoginFlow,
} from "../vendor/ofm/src/trae-oauth.ts";

const CN = {
  ...TRAE,
  id: "trae",
  displayName: "Trae CN IDE",
  clientId: "ono9krqynydwx5",
  ideVersion: "3.4.2",
  ideVersionCode: "1238630385922",
} as unknown as TraeProduct;

test("Trae CN IDE login URL carries the native IDE callback contract", () => {
  const callback = "http://127.0.0.1:18080/authorize";
  const url = new URL(
    buildTraeLoginURL(CN, "machine-0000000000000001", "device-01", callback),
  );
  assert.equal(url.origin, "https://www.trae.cn");
  assert.equal(url.pathname, "/authorization");
  assert.equal(url.searchParams.get("client_id"), "ono9krqynydwx5");
  assert.equal(url.searchParams.get("login_channel"), "native_ide");
  assert.equal(url.searchParams.get("auth_type"), "local");
  assert.equal(url.searchParams.get("auth_callback_url"), callback);
  assert.equal(url.searchParams.get("x_app_version"), "3.4.2");
  assert.equal(
    url.searchParams.get("x_app_version_code"),
    null,
    "the IDE version code is not part of the authorization URL",
  );
  assert.equal(
    url.searchParams.get("login_trace_id"),
    "0000001device-01",
    "the callback is correlated by the trailing 16 characters",
  );
});

test("Trae CN IDE login completes through the local callback and ExchangeToken", async (t) => {
  const exchangeBodies: string[] = [];
  let userInfoCalls = 0;
  const oauth = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === TRAE_EXCHANGE_PATH) {
        exchangeBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Result: {
              Token: "cn-access-token",
              RefreshToken: "cn-refresh-token-2",
              TokenExpireAt: Date.now() + 3_600_000,
              RefreshExpireAt: Date.now() + 7_200_000,
            },
          }),
        );
        return;
      }
      if (req.url === TRAE_USER_INFO_PATH) {
        userInfoCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Result: {
              UserID: "cn-user",
              ScreenName: "Trae CN Tester",
              EnterpriseID: "cn-tenant",
              NonPlainTextMobile: "138******00",
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    oauth.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    oauth.closeAllConnections();
    await new Promise<void>((resolve) => oauth.close(() => resolve()));
  });
  const port = (oauth.address() as AddressInfo).port;
  const product = {
    ...CN,
    oauthHost: `http://127.0.0.1:${port}`,
  } as unknown as TraeProduct;

  const started = await startTraeLoginFlow({
    product,
    callbackPort: 0,
  });
  t.after(() => started.close());
  const callbackUrl = new URL(started.loginUrl).searchParams.get(
    "auth_callback_url",
  );
  assert.ok(callbackUrl, "login URL must announce the local callback");
  const callback = new URL(callbackUrl);
  callback.searchParams.set("refreshToken", "cn-refresh-token-1");
  callback.searchParams.set(
    "userInfo",
    JSON.stringify({
      UserID: "cn-user",
      ScreenName: "Trae CN Tester",
      TenantID: "cn-tenant",
    }),
  );

  const browser = await fetch(callback);
  assert.equal(browser.status, 200);
  const result = await started.result;
  assert.equal(result.refreshable, true);
  const credential = JSON.parse(result.access);
  assert.equal(credential.access_token, "cn-access-token");
  assert.equal(credential.refresh_token, "cn-refresh-token-2");
  assert.equal(credential.uid, "cn-user");
  assert.equal(credential.nickname, "Trae CN Tester");
  assert.equal(credential.phone, "138******00");
  assert.equal(credential.machine_id.length > 0, true);
  assert.equal(credential.device_id.length > 0, true);
  assert.equal(userInfoCalls, 1);

  const exchange = JSON.parse(exchangeBodies[0]);
  assert.equal(exchange.ClientID, "ono9krqynydwx5");
  assert.equal(exchange.RefreshToken, "cn-refresh-token-1");
});
