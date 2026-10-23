/**
 * 各渠道 `…Detailed` 变体必须**真的**把上游原因带出来。
 *
 * 这一组是本次改动的核心承诺：旧实现一律 `return null`，界面只能显示
 * 「凭据失效或响应异常」。这里用合成响应逐个渠道验证「失败时 error 非空且含
 * 上游信息」，并用同一份成功响应验证「成功时不产生 error」——
 * 后者防的是把正常读数误判成失败的倒退。
 *
 * 全部为合成响应，不联网、不读取真实凭据。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fetchCreditBalanceDetailed } from "../vendor/ofm/src/credits.ts";
import { CODEBUDDY } from "../vendor/ofm/src/product.ts";
import { fetchQoderCreditBalanceDetailed } from "../vendor/ofm/src/qoder-credits.ts";
import { QODER } from "../vendor/ofm/src/qoder-product.ts";
import { fetchTraeCreditBalanceDetailed } from "../vendor/ofm/src/trae-credits.ts";
import { TRAE } from "../vendor/ofm/src/trae-product.ts";
import { fetchLoomyCreditBalanceDetailed } from "../vendor/ofm/src/loomy-credits.ts";
import { LOOMY } from "../vendor/ofm/src/loomy-product.ts";
import { fetchRaccoonCreditBalanceDetailed } from "../vendor/ofm/src/raccoon-credits.ts";
import { RACCOON } from "../vendor/ofm/src/raccoon-product.ts";

/** 统一的合成 fetcher：给定状态码与响应体。 */
const respond = (status: number, body: string) =>
  (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as typeof fetch;

/** 断言「失败且原因里带上了这些片段」。 */
function expectFailure(result: { balance: unknown; error?: string }, ...needles: string[]) {
  assert.equal(result.balance, null);
  assert.equal(typeof result.error, "string");
  for (const needle of needles)
    assert.ok(
      String(result.error).includes(needle),
      `原因里应包含 ${needle}，实际是：${result.error}`,
    );
}

test("buddy：业务码与中文原因都带出", async () => {
  const result = await fetchCreditBalanceDetailed(
    { access_token: "a", refresh_token: "r" } as any,
    CODEBUDDY,
    respond(403, '{"code":40302,"message":"账号已被禁用"}'),
  );
  expectFailure(result, "40302", "账号已被禁用");
});

test("qoder：非 2xx 带出状态码与响应片段", async () => {
  const result = await fetchQoderCreditBalanceDetailed(
    { access_token: "a", uid: "u", machine_id: "m" } as any,
    QODER,
    respond(403, '{"code":"Forbidden","message":"token expired"}'),
  );
  expectFailure(result, "403", "token expired");
});

test("qoder：网络故障保留底层消息", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const result = await fetchQoderCreditBalanceDetailed(
    { access_token: "a", uid: "u", machine_id: "m" } as any,
    QODER,
    failing,
  );
  expectFailure(result, "fetch failed");
});

test("trae：postJson 整理的 HTTP 原因被保留", async () => {
  const result = await fetchTraeCreditBalanceDetailed(
    { access_token: "a", uid: "u" } as any,
    TRAE,
    respond(429, "too many requests"),
  );
  expectFailure(result, "429");
});

test("loomy：业务码与 message 带出", async () => {
  const result = await fetchLoomyCreditBalanceDetailed(
    { access_token: "a" } as any,
    LOOMY,
    respond(200, '{"code":"100002","desc":"缺少 token"}'),
  );
  expectFailure(result, "缺少 token");
});

test("raccoon：业务码带出", async () => {
  const result = await fetchRaccoonCreditBalanceDetailed(
    RACCOON,
    { access_token: "a" } as any,
    respond(200, '{"code":401,"message":"登录已失效"}'),
  );
  expectFailure(result, "登录已失效");
});

test("成功响应不产生 error（防止把正常读数误判成失败）", async () => {
  // buddy 的成功形状：data.Response.Data.Accounts[]
  const buddy = await fetchCreditBalanceDetailed(
    { access_token: "a", refresh_token: "r" } as any,
    CODEBUDDY,
    respond(
      200,
      JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                {
                  PackageName: "包",
                  CapacityUnit: "credit",
                  CycleCapacityRemain: 100,
                  CycleCapacitySize: 200,
                  CycleCapacityUsed: 100,
                  Status: 1,
                },
              ],
            },
          },
        },
      }),
    ),
  );
  assert.equal(buddy.error, undefined);
  assert.equal(buddy.balance?.total, 100);
  assert.equal(buddy.balance?.packages.length, 1);

  // loomy 的成功形状：字符串 code + balance / dailyBalance
  const loomy = await fetchLoomyCreditBalanceDetailed(
    { access_token: "a" } as any,
    LOOMY,
    respond(200, '{"code":"000000","data":{"balance":100,"dailyBalance":20,"availableBalance":120}}'),
  );
  assert.equal(loomy.error, undefined);
  assert.equal(loomy.balance?.total, 120);

  // raccoon 的成功形状：available_points
  const raccoon = await fetchRaccoonCreditBalanceDetailed(
    RACCOON,
    { access_token: "a" } as any,
    respond(200, '{"code":0,"data":{"available_points":500,"reward_points":500}}'),
  );
  assert.equal(raccoon.error, undefined);
  assert.equal(raccoon.balance?.total, 500);
});
