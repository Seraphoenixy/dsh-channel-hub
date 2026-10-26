import test from "node:test";
import assert from "node:assert/strict";
import { rateLabel, promotionNote, promotionWindow } from "../src/core/rate.ts";
import { readOffPeakDiscount, readActivityDiscount } from "../vendor/ofm/src/trae.ts";

/**
 * Trae 时段折扣（`activity_discount.data.off_peak`）。
 *
 * 真实数据形状取自 `~/.dsh/trae-cn/models.json`（20 个模型）：
 *
 * | 模型 | `current.discount_type` | `off_peak` |
 * |---|---|---|
 * | `DeepSeek-V4-Flash-Official` | `none` | 0.2→0.1，00:00–08:00 / 22:00–24:00 |
 * | `deepseek-v4.1-flash` | `off_peak` | 0.12→0.06，工作日三段 + 周末全天 |
 *
 * 旧实现只读 `current`，于是前者（窗口外抓到的快照）**整条折扣被静默丢弃**。
 */

/** 把 `display_contact_config` 的 JSON 字符串拼出来（真实形态是字符串，不是对象）。 */
function entry(activityDiscount) {
  return {
    display_contact_config: JSON.stringify({
      consumption_rate: { enable: true, data: { rate: 0.2 } },
      activity_discount: activityDiscount,
    }),
  };
}

/** 实测形状：全天 00:00–08:00 与 22:00–24:00 两段。 */
const FLASH_OFF_PEAK = {
  enable: true,
  subKey: "off_peak_discount",
  data: {
    current: {
      discount_type: "none",
      before_consumption_rate: 0.2,
      consumption_rate: 0.2,
      discount: 100,
    },
    off_peak: {
      before_consumption_rate: 0.2,
      after_consumption_rate: 0.1,
      discount: 50,
      time_windows: [
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 480 },
        { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 1320, end_minute: 1440 },
      ],
    },
  },
};

/** 实测形状：工作日三段 + 周末全天，带时区。 */
const FLASH_41_OFF_PEAK = {
  enable: true,
  subKey: "off_peak_member_discount_18_9",
  data: {
    current: {
      discount_type: "off_peak",
      before_consumption_rate: 0.12,
      consumption_rate: 0.06,
      discount: 50,
    },
    member: { before_consumption_rate: 0.12, after_consumption_rate: 0.06, discount: 50 },
    off_peak: {
      before_consumption_rate: 0.12,
      after_consumption_rate: 0.06,
      discount: 50,
      time_windows: [
        { weekdays: [1, 2, 3, 4, 5], start_minute: 0, end_minute: 540 },
        { weekdays: [1, 2, 3, 4, 5], start_minute: 720, end_minute: 840 },
        { weekdays: [1, 2, 3, 4, 5], start_minute: 1080, end_minute: 1440 },
        { weekdays: [6, 7], start_minute: 0, end_minute: 1440 },
      ],
      time_zone: "Asia/Shanghai",
    },
  },
};

/* ─────────────────────────── 解析层 ─────────────────────────── */

test("Trae off-peak is parsed even when the current snapshot says none", () => {
  // 这是本次修复的核心：`current.discount_type === "none"` 是窗口外抓取的常态，
  // 不能据此判定「没有活动」。
  const parsed = readOffPeakDiscount(entry(FLASH_OFF_PEAK));
  assert.equal(parsed?.beforeRate, 0.2);
  assert.equal(parsed?.afterRate, 0.1);
  assert.equal(parsed?.windows.length, 2);
  assert.deepEqual(parsed?.windows[0], {
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startMinute: 0,
    endMinute: 480,
  });
});

test("Trae off-peak keeps the timezone and accepts 1440 as end of day", () => {
  const parsed = readOffPeakDiscount(entry(FLASH_41_OFF_PEAK));
  assert.equal(parsed?.timezone, "Asia/Shanghai");
  assert.equal(parsed?.windows.length, 4);
  // 1440 = 当日 24:00，合法值，不能被当成脏数据丢掉。
  assert.equal(parsed?.windows[2].endMinute, 1440);
});

test("Trae off-peak refuses to infer activity from a window-less block", () => {
  // 没有 time_windows 就无法判断「何时生效」，宁可当作没有。
  assert.equal(
    readOffPeakDiscount(
      entry({
        enable: true,
        data: { off_peak: { before_consumption_rate: 0.2, after_consumption_rate: 0.1 } },
      }),
    ),
    undefined,
  );
  // 空数组同理。
  assert.equal(
    readOffPeakDiscount(
      entry({
        enable: true,
        data: {
          off_peak: {
            before_consumption_rate: 0.2,
            after_consumption_rate: 0.1,
            time_windows: [],
          },
        },
      }),
    ),
    undefined,
  );
});

test("Trae off-peak drops blocks that are not a real discount", () => {
  const noDiscount = {
    enable: true,
    data: {
      off_peak: {
        before_consumption_rate: 0.2,
        after_consumption_rate: 0.2,
        time_windows: [{ start_minute: 0, end_minute: 480 }],
      },
    },
  };
  assert.equal(readOffPeakDiscount(entry(noDiscount)), undefined);
  const disabled = {
    enable: false,
    data: {
      off_peak: {
        before_consumption_rate: 0.2,
        after_consumption_rate: 0.1,
        time_windows: [{ start_minute: 0, end_minute: 480 }],
      },
    },
  };
  assert.equal(readOffPeakDiscount(entry(disabled)), undefined);
});

test("Trae off-peak rejects malformed windows but keeps the valid ones", () => {
  const parsed = readOffPeakDiscount(
    entry({
      enable: true,
      data: {
        off_peak: {
          before_consumption_rate: 0.2,
          after_consumption_rate: 0.1,
          time_windows: [
            { start_minute: 0, end_minute: 0 }, // 零长度：丢
            { start_minute: -10, end_minute: 480 }, // 负值：丢
            { start_minute: 1500, end_minute: 1600 }, // 越界：丢
            { start_minute: 1320, end_minute: 1440 }, // 合法
          ],
        },
      },
    }),
  );
  assert.equal(parsed?.windows.length, 1);
  assert.equal(parsed?.windows[0].startMinute, 1320);
});

test("Trae off-peak is not confused with the non-recurring discount types", () => {
  // `subsidy` / `member` / `limited` 没有 time_windows，必须走另一条路。
  const subsidy = readOffPeakDiscount(
    entry({
      enable: true,
      data: {
        current: { discount_type: "subsidy" },
        subsidy: { before_consumption_rate: 0.4, after_consumption_rate: 0.2 },
        member: { before_consumption_rate: 0.4, after_consumption_rate: 0.1 },
      },
    }),
  );
  assert.equal(subsidy, undefined);
});

/* ─────────────────────────── 展示层：倍率 ─────────────────────────── */

/** 构造一个带 offPeak 的目录条目（模拟 vendor 解析后的形状）。 */
function model(offPeak, creditsRate = 0.2) {
  return { creditsRate, offPeak };
}

const TWO_WINDOWS = {
  beforeRate: 0.2,
  afterRate: 0.1,
  windows: [
    { startMinute: 0, endMinute: 480 },
    { startMinute: 1320, endMinute: 1440 },
  ],
};

test("Trae rate shows the discount only inside the window", () => {
  // 2026-10-24 03:00 Asia/Shanghai ⇒ 在 00:00–08:00 内。
  const inside = new Date("2026-10-24T03:00:00+08:00");
  assert.equal(rateLabel(model(TWO_WINDOWS), inside), "x0.2→x0.1");
  // 同日 12:00 ⇒ 两段窗口都不覆盖，只报原价（不暗示折扣）。
  const outside = new Date("2026-10-24T12:00:00+08:00");
  assert.equal(rateLabel(model(TWO_WINDOWS), outside), "x0.2");
  // 22:30 ⇒ 落在 22:00–24:00 段内。
  assert.equal(
    rateLabel(model(TWO_WINDOWS), new Date("2026-10-24T22:30:00+08:00")),
    "x0.2→x0.1",
  );
});

test("Trae rate handles the 24:00 end boundary exactly", () => {
  const at2359 = new Date("2026-10-24T23:59:00+08:00");
  assert.equal(rateLabel(model(TWO_WINDOWS), at2359), "x0.2→x0.1");
  // 24:00 即次日 00:00 —— 属于第二段窗口（00:00–08:00）而不是前一段的尾巴。
  const atMidnight = new Date("2026-10-25T00:00:00+08:00");
  assert.equal(rateLabel(model(TWO_WINDOWS), atMidnight), "x0.2→x0.1");
});

test("Trae rate respects the weekday restriction", () => {
  // 2026-10-24 是周六。工作日窗口（1–5）在周六不该生效。
  const weekdayOnly = {
    beforeRate: 0.12,
    afterRate: 0.06,
    timezone: "Asia/Shanghai",
    windows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 1440 }],
  };
  assert.equal(
    rateLabel(model(weekdayOnly, 0.12), new Date("2026-10-24T12:00:00+08:00")),
    "x0.12",
    "Saturday must not match a Monday-Friday window",
  );
  // 2026-10-26 是周一。
  assert.equal(
    rateLabel(model(weekdayOnly, 0.12), new Date("2026-10-26T12:00:00+08:00")),
    "x0.12→x0.06",
  );
});

test("Trae rate converts through the declared timezone, not the host clock", () => {
  const shanghai = {
    beforeRate: 0.2,
    afterRate: 0.1,
    timezone: "Asia/Shanghai",
    windows: [{ startMinute: 0, endMinute: 480 }],
  };
  // 2026-10-24T20:00Z = 次日 04:00 Asia/Shanghai ⇒ 在窗口内。
  assert.equal(
    rateLabel(model(shanghai), new Date("2026-10-24T20:00:00Z")),
    "x0.2→x0.1",
  );
  // 2026-10-24T04:00Z = 12:00 Asia/Shanghai ⇒ 窗口外。
  assert.equal(rateLabel(model(shanghai), new Date("2026-10-24T04:00:00Z")), "x0.2");
});

test("Trae rate handles a window that crosses midnight", () => {
  const overnight = {
    beforeRate: 0.3,
    afterRate: 0.15,
    windows: [{ startMinute: 1320, endMinute: 120 }], // 22:00–02:00
  };
  assert.equal(
    rateLabel(model(overnight, 0.3), new Date("2026-10-24T23:00:00+08:00")),
    "x0.3→x0.15",
  );
  // 次日 01:00 仍属该窗口。
  assert.equal(
    rateLabel(model(overnight, 0.3), new Date("2026-10-25T01:00:00+08:00")),
    "x0.3→x0.15",
  );
  assert.equal(
    rateLabel(model(overnight, 0.3), new Date("2026-10-25T12:00:00+08:00")),
    "x0.3",
  );
});

test("Trae rate ignores a window-less or degenerate off-peak block", () => {
  assert.equal(rateLabel({ creditsRate: 0.2 }, new Date()), "x0.2");
  assert.equal(
    rateLabel(model({ beforeRate: 0.2, afterRate: 0.1, windows: [] }), new Date()),
    "x0.2",
  );
  // after 不小于 before：不是折扣，退回快照倍率。
  assert.equal(
    rateLabel(
      model({ beforeRate: 0.2, afterRate: 0.2, windows: [{ startMinute: 0, endMinute: 480 }] }),
      new Date("2026-10-24T03:00:00+08:00"),
    ),
    "x0.2",
  );
});

/* ─────────────────────────── 展示层：文案 ─────────────────────────── */

test("Trae promotion note keeps the long window list out of the chip", () => {
  // 实测 `deepseek-v4.1-flash` 有 4 段窗口；拼进 `flex:none` 的 chip 会撑破整行。
  // 故 chip 只说「错峰 / 未生效」，完整时段走 promotionWindow（进 title）。
  const inside = promotionNote(model(TWO_WINDOWS), new Date("2026-10-24T03:00:00+08:00"));
  assert.equal(inside, "错峰");
  const outside = promotionNote(model(TWO_WINDOWS), new Date("2026-10-24T12:00:00+08:00"));
  assert.equal(outside, "错峰（未生效）");
  // 时段信息不丢，只是换了位置。
  assert.equal(
    promotionWindow(model(TWO_WINDOWS), new Date("2026-10-24T12:00:00+08:00")),
    "00:00–08:00 / 22:00–24:00",
  );
});

test("Trae promotion window is shown even outside the active period", () => {
  // 用户要能知道「几点到几点打折」才能安排，窗口外藏起来等于活动不可发现。
  const window = promotionWindow(model(TWO_WINDOWS), new Date("2026-10-24T12:00:00+08:00"));
  assert.equal(window, "00:00–08:00 / 22:00–24:00");
});

test("Trae promotion note marks a cross-midnight window explicitly", () => {
  const overnight = {
    beforeRate: 0.3,
    afterRate: 0.15,
    windows: [{ startMinute: 1320, endMinute: 120 }],
  };
  // chip 不含时段（见上一条），跨零点的写法在 promotionWindow 里。
  assert.equal(
    promotionWindow(model(overnight, 0.3), new Date("2026-10-24T12:00:00+08:00")),
    "22:00–次日02:00",
  );
});

test("Trae promotion note does not fire for non-recurring discounts", () => {
  /**
   * 一次性活动（`limited`）走截止时间文案，错峰文案不得抢先。
   *
   * ⚠️ `discountEndsAtSec` 与 `originalCreditsRate` 在 vendor 里由**同一个**
   * `discount` 对象成对写出（见 `parseTraeConfigEntry`），不可能只有其一 ——
   * 夹具必须照这个真实形状构造，否则测的是不存在的状态。
   */
  const once = {
    creditsRate: 0.08,
    originalCreditsRate: 0.8,
    discountEndsAtSec: Math.floor(Date.now() / 1000) + 86400,
  };
  assert.match(String(promotionNote(once, new Date())), /限时折扣至/);
  // 没有原价 ⇒ 无法证明存在折扣 ⇒ 不编造文案（真实数据里不会出现）。
  assert.equal(promotionNote({ creditsRate: 0.2, discountEndsAtSec: 1792079940 }), undefined);
});

test("a current snapshot inside off-peak survives when the window block is missing", () => {
  // `current` 明说「此刻在错峰档」，但 off_peak 块缺失/无窗口 —— 此时若让位给
  // 窗口推算，折扣会整条消失（比显示一个可能过期的快照更糟）。
  const entry = {
    display_contact_config: JSON.stringify({
      consumption_rate: { enable: true, data: { rate: 0.06 } },
      activity_discount: {
        enable: true,
        data: {
          current: {
            discount_type: "off_peak",
            before_consumption_rate: 0.12,
            consumption_rate: 0.06,
          },
        },
      },
    }),
  };
  assert.equal(readOffPeakDiscount(entry), undefined);
  // 于是 readActivityDiscount 必须照旧给出原价，而不是让折扣消失。
  assert.deepEqual(readActivityDiscount(entry), { originalRate: 0.12 });
});
