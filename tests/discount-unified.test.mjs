import test from "node:test";
import assert from "node:assert/strict";
import {
  discountOf,
  isActive,
  rateLabel,
  promotionNote,
  promotionWindow,
} from "../src/core/rate.ts";
import { promotionsFromConfig } from "../src/core/promotion.ts";

/**
 * 时段折扣的**统一口径**（2026-10-24）。
 *
 * 同一个缺陷此前在三处各写了一遍，每一处都漏了「按窗口判断」：
 *
 * | 渠道 | 旧行为 | 后果 |
 * |---|---|---|
 * | Qoder | 直接显示 `priceFactor`（抓取那一刻的生效价） | 窗口外抓 ⇒ 整天显示折后价 |
 * | Buddy | 只校验 `validFrom`/`validUntil`，不看 `daily` | 中午显示夜间价 |
 * | Trae | 只读 `activity_discount.data.current`（抓取快照） | 窗口外抓 ⇒ 折扣整条消失 |
 *
 * 现在只有 `isActive()` 一条判据，本文件逐渠道钉死它。
 */

/* ─────────────────────────── Qoder ─────────────────────────── */

/** 实测形状（线上快照 `catalog:qodercn:*` 的 `qmodel_38max`）。 */
const qoder = {
  priceFactor: 0.2,
  promotion: {
    active: true,
    discountFactor: 0.4,
    beforePromotionPriceFactor: 0.5,
    windowStart: "22:00",
    windowEnd: "08:00",
    badgeZh: "错峰 4 折",
  },
};

test("Qoder: price comes from the promotion parameters, not the fetch-time snapshot", () => {
  // 12:00 不在 22:00–08:00 内 ⇒ 原价 0.5（**不是**快照里的 0.2）。
  assert.equal(rateLabel(qoder, new Date("2026-10-24T12:00:00+08:00")), "x0.5");
  // 03:00 在窗口内 ⇒ 0.5 × 0.4 = 0.2。
  assert.equal(rateLabel(qoder, new Date("2026-10-24T03:00:00+08:00")), "x0.5→x0.2");
});

test("Qoder: a snapshot captured outside the window still shows the discount inside it", () => {
  /**
   * 这是最要命的一种：目录在白天抓，`price_factor` 记的是原价 0.5。
   * 旧实现整天显示 `0.5×`，凌晨也不打折 —— 用户以为没有活动。
   */
  const capturedOutside = { ...qoder, priceFactor: 0.5 };
  assert.equal(
    rateLabel(capturedOutside, new Date("2026-10-24T03:00:00+08:00")),
    "x0.5→x0.2",
  );
  assert.equal(
    rateLabel(capturedOutside, new Date("2026-10-24T12:00:00+08:00")),
    "x0.5",
  );
});

test("Qoder: the badge says whether the window applies now", () => {
  assert.equal(promotionNote(qoder, new Date("2026-10-24T12:00:00+08:00")), "错峰 4 折（未生效）");
  assert.equal(promotionNote(qoder, new Date("2026-10-24T03:00:00+08:00")), "错峰 4 折");
  // 时段本身与是否生效无关 —— 用户要知道几点打折才能安排。
  assert.equal(promotionWindow(qoder, new Date("2026-10-24T12:00:00+08:00")), "22:00–次日08:00");
});

/* ─────────────────────────── Buddy ─────────────────────────── */

/** 实测形状（线上快照 `catalog:buddy:*` 的 `glm-5.2`，夜间 5 折）。 */
const buddy = {
  creditsRate: "x0.79",
  promotion: {
    daily: [{ start: "23:00", end: "7:50" }],
    timezone: "Asia/Shanghai",
    label: "夜间折扣",
    rate: "x0.50",
  },
};

test("Buddy: the daily window is checked, not just the validity range", () => {
  // 旧实现只校验 validFrom/validUntil，中午也会显示 x0.79→x0.50。
  assert.equal(rateLabel(buddy, new Date("2026-10-24T12:00:00+08:00")), "x0.79");
  assert.equal(rateLabel(buddy, new Date("2026-10-24T01:00:00+08:00")), "x0.79→x0.5");
  // 边界：23:00 起、07:50 止（含起点、不含终点）。
  assert.equal(rateLabel(buddy, new Date("2026-10-24T23:00:00+08:00")), "x0.79→x0.5");
  assert.equal(rateLabel(buddy, new Date("2026-10-24T07:50:00+08:00")), "x0.79");
  assert.equal(rateLabel(buddy, new Date("2026-10-24T07:49:00+08:00")), "x0.79→x0.5");
});

test("Buddy: a free nightly window reports 免费 only inside the window", () => {
  const free = {
    creditsRate: "x0.29",
    promotion: {
      daily: [{ start: "23:00", end: "08:00" }],
      timezone: "Asia/Shanghai",
      label: "夜间免费",
      rate: "免费",
    },
  };
  assert.equal(rateLabel(free, new Date("2026-10-24T01:00:00+08:00")), "x0.29→免费");
  assert.equal(rateLabel(free, new Date("2026-10-24T12:00:00+08:00")), "x0.29");
  assert.equal(promotionNote(free, new Date("2026-10-24T12:00:00+08:00")), "夜间免费（未生效）");
});

test("Buddy: an already-fetched discounted rate does not bypass the window", () => {
  /**
   * 目录在窗口内抓时 OFM 会额外写下 `discountedCreditsRate`。
   * 旧实现直接认它 —— 于是窗口外也显示折后价。
   */
  const capturedInside = { ...buddy, discountedCreditsRate: "x0.50" };
  assert.equal(rateLabel(capturedInside, new Date("2026-10-24T12:00:00+08:00")), "x0.79");
  assert.equal(rateLabel(capturedInside, new Date("2026-10-24T01:00:00+08:00")), "x0.79→x0.5");
});

test("Buddy: a promotion equal to the list price is not a discount", () => {
  const noDiscount = {
    creditsRate: "x0.50",
    promotion: {
      daily: [{ start: "23:00", end: "07:50" }],
      timezone: "Asia/Shanghai",
      rate: "x0.50",
    },
  };
  assert.equal(discountOf(noDiscount), undefined);
  assert.equal(rateLabel(noDiscount, new Date("2026-10-24T01:00:00+08:00")), "x0.50");
});

test("Buddy: promotions from /v3/config keep their window all the way through", () => {
  // 端到端：目录响应 → promotionsFromConfig → discountOf → rateLabel。
  const map = promotionsFromConfig({
    data: {
      modelPromotions: [
        {
          enabled: true,
          priority: 100,
          discount: { discountedCredits: "0.50x", factor: 0.5 },
          badge: { label: "夜间折扣" },
          schedule: { daily: [{ start: "23:00", end: "7:50" }], timezone: "Asia/Shanghai" },
          modelIds: ["glm-5.2"],
        },
      ],
    },
  });
  const model = { creditsRate: "x0.79", promotion: map.get("glm-5.2") };
  assert.equal(rateLabel(model, new Date("2026-10-24T12:00:00+08:00")), "x0.79");
  assert.equal(rateLabel(model, new Date("2026-10-24T01:00:00+08:00")), "x0.79→x0.5");
  assert.equal(promotionWindow(model), "23:00–次日07:50");
});

/* ─────────────────────── 跨渠道：共用判据 ─────────────────────── */

test("every channel resolves to the same Discount shape and the same isActive rule", () => {
  const models = {
    qoder,
    buddy,
    trae: {
      creditsRate: 0.2,
      offPeak: {
        beforeRate: 0.2,
        afterRate: 0.1,
        windows: [{ startMinute: 0, endMinute: 480 }],
      },
    },
  };
  const noon = new Date("2026-10-24T12:00:00+08:00");
  const night = new Date("2026-10-24T02:00:00+08:00");
  for (const [name, model] of Object.entries(models)) {
    const found = discountOf(model);
    assert.ok(found, `${name}: must resolve to a Discount`);
    // 三个渠道都必须给出「原价 → 折后价」，且原价严格大于折后价。
    assert.ok(
      typeof found.before === "number" && typeof found.after === "number",
      `${name}: must carry both prices`,
    );
    assert.ok(found.before > found.after, `${name}: before must exceed after`);
    // 三个渠道的窗口都覆盖凌晨 02:00、都不覆盖中午 12:00。
    assert.equal(isActive(found, night), true, `${name}: must be active at 02:00`);
    assert.equal(isActive(found, noon), false, `${name}: must be inactive at 12:00`);
  }
});

test("the timezone is honored per channel, not taken from the host clock", () => {
  // 三家都用同一默认时区（Asia/Shanghai），显式声明时以声明为准。
  const shanghai = new Date("2026-10-24T20:00:00Z"); // = 次日 04:00 +08:00
  for (const model of [
    qoder,
    buddy,
    {
      creditsRate: 0.2,
      offPeak: {
        beforeRate: 0.2,
        afterRate: 0.1,
        windows: [{ startMinute: 0, endMinute: 480 }],
      },
    },
  ]) {
    const found = discountOf(model);
    assert.equal(isActive(found, shanghai), true, "04:00 +08:00 must be in a night window");
  }
});