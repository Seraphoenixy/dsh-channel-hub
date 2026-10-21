/**
 * Loomy / Raccoon 的余额形状回归。
 *
 * 两者都只有「各池还剩多少」，**没有容量字段**，所以包级 `total` 必须是 0；
 * 一旦填成 `remaining`，宿主会把剩余当成面值，卡片显示成
 * 「19,992 / 19,992积分」+ 100% 进度条（把剩下多少当成总共有多少）。
 *
 * 全部使用合成响应，不联网、不读真实凭据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchLoomyCreditBalance } from "../vendor/ofm/src/loomy-credits.ts";
import { fetchRaccoonCreditBalance } from "../vendor/ofm/src/raccoon-credits.ts";
import { LOOMY } from "../vendor/ofm/src/loomy-product.ts";
import { RACCOON } from "../vendor/ofm/src/raccoon-product.ts";

/** 返回固定 JSON 的 fetcher 替身。 */
const reply = (body) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("Loomy balance reports pools without inventing a face value", async () => {
  const balance = await fetchLoomyCreditBalance(
    { access_token: "synthetic-access" },
    LOOMY,
    reply({
      code: "000000",
      data: { balance: 15000, dailyBalance: 4992, availableBalance: 19992 },
    }),
  );
  assert.ok(balance, "balance must be reported");
  // 顶层 `total` 是「当前可用余额」（两池之和），不是容量。
  assert.equal(balance.total, 19992);
  assert.deepEqual(
    balance.packages.map((pkg) => [pkg.name, pkg.remaining, pkg.total]),
    [
      ["永久积分", 15000, 0],
      ["每日赠送", 4992, 0],
    ],
  );
  // 面值未知时也不能留 `used: 0` —— 那是在断言「确实没用过」。
  assert.ok(
    balance.packages.every((pkg) => pkg.used === undefined),
    "used must stay unknown when the upstream omits it",
  );
});

test("Raccoon balance reports pools without inventing a face value", async () => {
  const balance = await fetchRaccoonCreditBalance(
    RACCOON,
    { access_token: "synthetic-access" },
    reply({
      code: 0,
      data: {
        available_points: 2100,
        reward_points: 3000,
        daily_points: 100,
        topup_points: 0,
      },
    }),
  );
  assert.ok(balance, "balance must be reported");
  assert.equal(balance.total, 2100);
  assert.ok(balance.packages.length > 0, "at least one pool must be listed");
  assert.ok(balance.packages.every((pkg) => pkg.total === 0));
  assert.ok(balance.packages.every((pkg) => pkg.used === undefined));
});
