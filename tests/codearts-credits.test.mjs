/**
 * CodeArts 积分余额回归（2026-10-30，用户报障「积分统一有问题，总积分包
 * 好像就是合计值不应被再次做加法」）。
 *
 * ## 根因
 *
 * `statistics/plugin` 的 `metrics[]` 里，`usageTotalPackageCredit`（总积分包）
 * 是**合计口径**，`usageBasicPackageCredit` / `usageOnDemandPackageCredit` /
 * `usageBonusPackageCredit` 三条是它的**构成明细**。旧解析把「总积分包」与
 * 三条分类一起 push 进 `CreditBalance.packages`，而宿主的汇总合约是
 * 「`total` = 各有效包剩余之和」—— 合计口径进了包列表就被再求和一次，
 * 卡片总额变成「分类之和 + 总额」≈ 两倍。
 *
 * 修复：总积分包只做 `total` 的锚点，不进 `packages`。
 *
 * 夹具全部为合成值（形状取自真实响应的字段名），不联网、不读真实账号。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEARTS_SNAP_ENGINE_URL,
  CODEARTS_PACKAGE_INFO_PATH,
  fetchCodeArtsAccountInfoDetailed,
} from "../vendor/ofm/src/codearts-credits.ts";
import { creditReading } from "../src/core/credits.ts";

/** 一份合成 metrics：总额锚点 155.67 = 三条分类剩余之和（与服务端口径一致）。 */
const FULL_METRICS = [
  {
    name: "usageTotalPackageCredit",
    package_credit_amount: 0,
    package_credit_used: 0,
    package_credit_remain: 155.67,
  },
  {
    name: "usageBasicPackageCredit",
    package_credit_amount: 100,
    package_credit_used: 44.33,
    package_credit_remain: 55.67,
  },
  {
    name: "usageOnDemandPackageCredit",
    package_credit_amount: 200,
    package_credit_used: 100,
    package_credit_remain: 100,
  },
  {
    name: "usageBonusPackageCredit",
    package_credit_amount: 100,
    package_credit_used: 100,
    package_credit_remain: 0,
  },
];

test("总积分包只做 total 锚点，不进资源包列表", async () => {
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async (url, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(url, CODEARTS_SNAP_ENGINE_URL + CODEARTS_PACKAGE_INFO_PATH);
      return new Response(
        JSON.stringify({
          package: {
            is_credit_package: "true",
            is_token_package: "false",
            spec_code: "codearts.agent.pro",
            package_name_cn: "CodeArts 专业版",
            status: "normal",
          },
          metrics: FULL_METRICS,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.ok(result.ok);
  const { credit, packageName } = result.info;
  assert.equal(packageName, "CodeArts 专业版");
  assert.ok(credit, "credit account must carry a balance");
  // 合计不作为包出现；包列表只剩三条可加的分类明细。
  assert.deepEqual(
    credit.packages.map((pkg) => pkg.name),
    ["基础积分包", "按需积分包", "赠送积分包"],
  );
  // 锚点 == 分类之和：宿主「各包相加」不会再翻倍。
  assert.equal(credit.total, 155.67);
  assert.equal(
    Math.round(credit.packages.reduce((sum, pkg) => sum + pkg.remaining, 0) * 100) / 100,
    credit.total,
  );
  assert.equal(credit.expiredTotal, 0);
});

test("宿主卡片按包求和恰好一次，与总额锚点一致", async () => {
  // 走与真实驱动完全相同的通路：driver.balance 原样返回 CodeArtsAccountInfo
  // （vendor 解析产物），宿主 creditReading 归一成卡片读数。
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async () =>
      new Response(
        JSON.stringify({
          package: { is_credit_package: "true", status: "normal", package_name_cn: "CodeArts 专业版" },
          metrics: FULL_METRICS,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(result.ok);
  const reading = creditReading({ at: 1, value: result.info });
  assert.ok(reading);
  assert.equal(reading.unit, "credit");
  assert.equal(reading.total, 155.67);
  assert.equal(reading.packages?.length, 3);
  assert.equal(reading.packagesCount, 3);
  // 三条分类都有面值：合计进度条可画，读数恰为「剩余 / 面值和」。
  assert.equal(reading.label, "155.67 / 400积分");
  assert.ok(Math.abs((reading.progress ?? 0) - 155.67 / 400) < 1e-9);
});

test("总额锚点优先于分类求和（分类口径漂移时不放大误差）", async () => {
  // 分类之和（160.67）与总额（155.67）不一致时，取服务端声明的总额，
  // 不做任何再加工 —— 更不把总额当包再 加一次。
  const drifted = FULL_METRICS.map((m) =>
    m.name === "usageBonusPackageCredit" ? { ...m, package_credit_remain: 5 } : m,
  );
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async () =>
      new Response(
        JSON.stringify({
          package: { is_credit_package: "true", status: "normal" },
          metrics: drifted,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(result.ok);
  assert.equal(result.info.credit?.total, 155.67);
});

test("总额 metric 缺失时回退为分类求和（面值未知则无进度条）", async () => {
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async () =>
      new Response(
        JSON.stringify({
          package: { is_credit_package: "true", status: "normal" },
          metrics: [
            { name: "usageBasicPackageCredit", package_credit_remain: 10 },
            { name: "usageOnDemandPackageCredit", package_credit_remain: 5 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(result.ok);
  const credit = result.info.credit;
  assert.ok(credit);
  assert.equal(credit.total, 15);
  assert.equal(credit.packages.length, 2);
  const reading = creditReading({
    at: 2,
    value: { isCreditPackage: true, packageName: "P", credit },
  });
  assert.ok(reading);
  // 分类没有面值：只显示剩余，不画进度条。
  assert.equal(reading.label, "15积分");
  assert.equal(reading.progress, undefined);
});

test("只有总积分包时仍有积分口径：总额如实显示，无进度条", async () => {
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async () =>
      new Response(
        JSON.stringify({
          package: { is_credit_package: "true", status: "normal" },
          metrics: [
            {
              name: "usageTotalPackageCredit",
              package_credit_remain: 88,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(result.ok);
  // 有口径但无分类明细：不是 undefined（那是「没有积分口径」）。
  assert.deepEqual(result.info.credit, { total: 88, packages: [], expiredTotal: 0 });
  const reading = creditReading({
    at: 3,
    value: { isCreditPackage: true, packageName: "P", credit: result.info.credit },
  });
  assert.ok(reading);
  assert.equal(reading.total, 88);
  assert.equal(reading.label, "88积分");
  assert.equal(reading.progress, undefined);
});

test("没有任何 credit metric 时仍返回无积分口径（undefined）", async () => {
  const result = await fetchCodeArtsAccountInfoDetailed(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async () =>
      new Response(
        JSON.stringify({
          package: { is_credit_package: "true", status: "normal" },
          metrics: [{ name: "usageSomeOtherMetric", package_credit_remain: 1 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(result.ok);
  assert.equal(result.info.credit, undefined);
  const reading = creditReading({
    at: 4,
    value: { isCreditPackage: true, packageName: "P", credit: result.info.credit },
  });
  assert.ok(reading);
  assert.match(String(reading.note), /没有额度明细/);
});
