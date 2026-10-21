/**
 * 额度读数的展示归一化（`src/core/credits.ts`）。
 *
 * 夹具全部是**合成值**：形状取自 vendor 各 `fetch*CreditBalance` 的返回
 * 与用户报障里出现过的真实形态，但没有任何真实账号数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  creditReading,
  formatCreditAmount,
  formatTokenAmount,
  formatUnitAmount,
  unitLabel,
  unitOf,
} from "../src/core/credits.ts";

test("a CreditBalance with several packages sums only active ones and keeps expired apart", () => {
  const reading = creditReading({
    at: 1700000000000,
    value: {
      total: 155.67,
      expiredTotal: 500,
      packages: [
        {
          name: "Free Plan Subscription",
          unit: "credits",
          remaining: 55.67,
          total: 100,
          used: 44.33,
          active: true,
          cycleEndTime: "2026-11-01T00:00:00Z",
          expiredTime: "",
        },
        {
          name: "Bonus Pack",
          unit: "credit",
          remaining: 100,
          total: 200,
          used: 100,
          active: true,
          expiredTime: "",
          deductionEndTime: 1790000000000,
        },
        {
          name: "过期活动包",
          unit: "credit",
          remaining: 500,
          total: 500,
          used: 0,
          active: false,
          expiredTime: "",
        },
      ],
    },
  });
  assert.ok(reading);
  // 单位 `credit` / `credits` 必须落进同一组，否则同一份额度会被拆成两组。
  assert.equal(reading.unit, "credit");
  assert.equal(reading.total, 155.67);
  assert.equal(reading.label, "155.67 / 300积分");
  assert.equal(reading.progress, 155.67 / 300);
  // 失效包不计入合计，单独给出。
  assert.equal(reading.expiredTotal, 500);
  assert.equal(reading.packagesCount, 3);
  const [plan, bonus, expired] = reading.packages ?? [];
  assert.equal(expired.active, false);
  assert.equal(plan.resetAt, "2026-11-01T00:00:00Z");
  assert.equal(bonus.expiresAt, new Date(1790000000000).toISOString());
  assert.equal(reading.at, 1700000000000);
});

test("a package without a face value shows remaining only and no invented 100%", () => {
  const reading = creditReading({
    at: 1,
    value: {
      total: 92.73,
      expiredTotal: 0,
      packages: [
        {
          name: "每日登录奖励",
          unit: "credit",
          remaining: 92.73,
          // LobsterAI 只下发剩余量，不区分周期总额。
          total: 0,
          used: 0,
          active: true,
          expiredTime: "",
        },
      ],
    },
  });
  assert.ok(reading);
  assert.equal(reading.label, "92.73积分");
  assert.equal(reading.progress, undefined);
  assert.equal(reading.packages?.[0].progress, undefined);
});

test("token amounts stay token, and mixed units are never summed", () => {
  const mixed = creditReading({
    at: 3,
    value: {
      total: 100,
      expiredTotal: 0,
      packages: [
        { name: "a", unit: "credit", remaining: 100, total: 100, active: true },
        { name: "b", unit: "token", remaining: 1e6, total: 1e6, active: true },
      ],
    },
  });
  assert.ok(mixed);
  // 1 亿 token 与 100 积分不能相加成一个数（用户报障的根因）。
  assert.equal(mixed.unit, undefined);
  assert.equal(mixed.total, undefined);
  assert.equal(mixed.label, "1.00MToken · 100积分");
  assert.equal(mixed.progress, undefined);
  assert.match(String(mixed.note), /不做合计/);
});

test("lookup failure is never rendered as zero", () => {
  // 各 vendor 用 `null` 表达「查不到」。
  const failed = creditReading({ at: 4, value: null });
  assert.ok(failed);
  assert.equal(failed.label, undefined);
  assert.equal(failed.total, undefined);
  assert.match(String(failed.error), /查询失败/);

  // 抛错时保留上次成功的读数，同时带上本次失败原因。
  const stale = creditReading({
    at: 5,
    value: {
      total: 12,
      expiredTotal: 0,
      packages: [
        {
          name: "每日赠送",
          unit: "credit",
          remaining: 12,
          total: 12,
          active: true,
        },
      ],
    },
    error: "网络中断",
    errorAt: 6,
  });
  assert.ok(stale);
  assert.equal(stale.label, "12 / 12积分");
  assert.equal(stale.error, "网络中断");

  // 从未查询过：undefined，界面显示「尚未查询」而不是 0。
  assert.equal(creditReading(undefined), undefined);
});

test("wrapped balances keep their reason and account tier", () => {
  const gemini = creditReading({
    at: 7,
    value: {
      balance: {
        total: 60,
        expiredTotal: 0,
        packages: [
          {
            name: "5 小时窗口",
            unit: "%",
            remaining: 20,
            total: 100,
            used: 80,
            active: true,
            cycleEndTime: "2026-10-21T03:00:00Z",
            expiredTime: "",
          },
          {
            name: "周窗口",
            unit: "%",
            remaining: 100,
            total: 100,
            used: 0,
            active: true,
            cycleEndTime: "2026-10-27T00:00:00Z",
            expiredTime: "",
          },
        ],
      },
      tier: { id: "g1-pro-tier", name: "Google AI Pro", label: "Pro" },
    },
  });
  assert.ok(gemini);
  assert.equal(gemini.unit, "percent");
  assert.equal(gemini.tags?.[0], "Pro");
  assert.equal(gemini.packages?.[0].label, "20 / 100%");
});

test("provider-specific shapes keep their own semantics", () => {
  const codeartsToken = creditReading({
    at: 9,
    value: {
      isCreditPackage: false,
      isTokenPackage: true,
      packageName: "CodeArts 基础版",
      packageStatus: "normal",
    },
  });
  assert.ok(codeartsToken);
  // 「非积分账户」不是故障：给说明，不给「查询失败」。
  assert.equal(codeartsToken.error, undefined);
  assert.match(String(codeartsToken.note), /Token 计费账户/);
  // 读数「什么时候拿到的」由宿主判定（`at` 来自快照），不由响应自己声明。
  assert.equal(codeartsToken.at, 9);
});

test("an unrecognized response is flagged instead of guessed", () => {
  const reading = creditReading({ at: 12, value: { whatever: true } });
  assert.ok(reading);
  assert.equal(reading.unknown, true);
  assert.equal(reading.label, undefined);
  assert.match(String(reading.error), /无法识别/);
});

test("pools reported without a face value show the balance only (Loomy / Raccoon)", () => {
  // 这两个渠道的余额端点只下发「各池还剩多少」，不下发容量。vendor 必须给
  // `total: 0`，否则宿主会把 remaining 当成面值，拼出「19,992 / 19,992」。
  const reading = creditReading({
    at: 20,
    value: {
      total: 19992,
      expiredTotal: 0,
      packages: [
        { name: "永久积分", unit: "积分", remaining: 15000, total: 0, active: true },
        { name: "每日赠送", unit: "积分", remaining: 4992, total: 0, active: true },
      ],
    },
  });
  assert.ok(reading);
  assert.equal(reading.total, 19992);
  // 只报剩余，绝不把剩余标成总额、也不补 100% 进度。
  assert.equal(reading.label, "19,992积分");
  assert.equal(reading.progress, undefined);
  assert.deepEqual(
    reading.packages?.map((p) => [p.label, p.progress]),
    [
      ["15,000积分", undefined],
      ["4,992积分", undefined],
    ],
  );
});

test("a partially-known face value never becomes the denominator", () => {
  // 任一有效包面值未知 ⇒ 合计面值不成立：只对一部分包求和会得到比剩余还小的
  // 分母（进度还能超过 100%），那是在报一个自己并不知道的数。
  const reading = creditReading({
    at: 21,
    value: {
      total: 130,
      expiredTotal: 0,
      packages: [
        { name: "已知面值", unit: "credit", remaining: 100, total: 100, active: true },
        { name: "面值未知", unit: "credit", remaining: 30, total: 0, active: true },
      ],
    },
  });
  assert.ok(reading);
  assert.equal(reading.label, "130积分");
  assert.equal(reading.progress, undefined);
});

test("display formatting matches the vendor conventions", () => {
  // 积分不压缩：用户要能与官方界面核对。
  assert.equal(formatCreditAmount(123456.78), "123,456.78");
  assert.equal(formatCreditAmount(800), "800");
  // token 才压缩。
  assert.equal(formatTokenAmount(94_539_275), "94.54M");
  assert.equal(formatTokenAmount(945_394), "945.39K");
  assert.equal(formatTokenAmount(12), "12");
  // 数值与单位之间不留空格（与用量徽标 `94.54MToken` 同形）。
  assert.equal(formatUnitAmount(800, "credit"), "800积分");
  assert.equal(formatUnitAmount(1e8, "token"), "100.00MToken");
  assert.equal(unitLabel(unitOf("credits")), "积分");
  assert.equal(unitLabel(unitOf(undefined)), "积分");
  assert.equal(unitLabel(unitOf("token")), "Token");
  assert.equal(unitLabel(unitOf("%")), "%");
});
