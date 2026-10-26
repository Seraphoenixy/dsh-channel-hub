/**
 * 模型计费系数的展示归一化。
 *
 * ## 统一模型（2026-10-24 重构）
 *
 * 各渠道的目录字段名不同，但**语义只有一套**：一个模型有一个「原价」，
 * 可能还有一个「限时/限时段的折后价」，以及它**什么时候生效**。
 *
 * 旧实现把「什么时候生效」分散在三处各写一遍，于是同一类缺陷出现了三次：
 *
 * | 渠道 | 旧行为 | 后果 |
 * |---|---|---|
 * | Trae | 只读 `activity_discount.data.current`（抓取快照） | 窗口外抓目录 ⇒ 整条折扣消失 |
 * | Buddy | 只校验 `validFrom`/`validUntil`，**不看 `daily` 时段** | 中午显示夜间价（`x0.79→x0.50` 在 12:00 也出现） |
 * | Qoder | 直接显示 `priceFactor`（抓取那一刻的生效价） | 窗口外抓 ⇒ 显示原价，窗口内抓 ⇒ 整天显示折后价 |
 *
 * 现在只有**一条**判据链：{@link discountOf} 把每个驱动归一成
 * {@link Discount}（原价 / 折后价 / 每日时段 / 有效期 / 星期限制），
 * {@link isActive} 是**唯一**判断「此刻是否生效」的函数。
 * 展示层（{@link rateLabel} / {@link promotionNote} / {@link promotionWindow}）
 * 全部只消费这两个结果，不再各自解释字段。
 *
 * ## 一条硬规则
 *
 * **不按「抓取时刻」判断，只按「窗口 + 当前时刻」判断。** 目录里的
 * 「当前价」类字段（Qoder 的 `price_factor`、Trae 的 `consumption_rate`）
 * 是抓取那一刻的快照，长期运行的会话里会过期 —— 拿它当真相，
 * 结果是价格随「上次刷新目录的时间」跳变，而不是随真实计费规则变化。
 *
 * ## 另一条硬规则
 *
 * **不编造**：字段缺失或不是有限数时返回 `undefined`，由调用方决定不渲染，
 * 而不是补一个 `x1`。`0` 必须原样显示（免费也是倍率）。
 */

/**
 * 每日时段。
 *
 * 两种输入形态（由各驱动的归一函数负责转换）：
 * - `start` / `end` 为 `HH:MM` 字符串（Qoder / Buddy）；
 * - `start` / `end` 为当日分钟数（Trae 的 `start_minute` / `end_minute`）。
 *
 * ⚠️ **`weekdays` 属于每个时段，不是整条活动**（2026-10-24 修正）：
 * Trae 实测 `deepseek-v4.1-flash` 的窗口是「工作日三段 + 周末全天」，
 * 把它合并成一个全局星期集会得到空交集（工作日 ∩ 周末 = ∅），
 * 于是退回「每天」—— 周末的全天窗口会覆盖掉工作日的所有限制。
 */
export interface DailySlot {
  start?: unknown;
  end?: unknown;
  /** 该时段的星期限制（1=周一 … 7=周日）；缺失表示每天。 */
  weekdays?: readonly number[];
}

/**
 * 一个折扣活动（各驱动字段已归一）。
 *
 * ⚠️ **这是展示层的唯一输入形状**：`rateLabel` / `promotionNote` /
 * `promotionWindow` 只认它，不认任何渠道原始字段。
 */
export interface Discount {
  /** 原价（折扣前倍率）。数值，`0` 合法（免费）。 */
  before?: number;
  /** 折后价。数值，`0` 合法（免费）。 */
  after?: number;
  /** 折后价的原始文本（`免费` / `x0.50`）；数值不可得时用它。 */
  afterText?: string;
  /** 每日时段；缺失表示不限时段。每个时段可带自己的星期限制。 */
  daily?: readonly DailySlot[];
  /** 时段时区（IANA）；缺失按 {@link DEFAULT_PROMO_TIMEZONE}。 */
  timezone?: string;
  /** 有效期起点（ISO）。 */
  validFrom?: string;
  /** 有效期终点（ISO）。 */
  validUntil?: string;
  /** 角标文案，如「夜间折扣」「错峰 4 折」。 */
  label?: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 时段时区缺省值：`Asia/Shanghai`（三家渠道的实测默认，与 Qoder 计费日界一致）。 */
export const DEFAULT_PROMO_TIMEZONE = "Asia/Shanghai";

/** 解析 `HH:MM`（容忍不补零）为当日分钟数；非法返回 undefined。 */
function minutesOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (m === null) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

/** 规整 `HH:MM` 文本用于展示；非法返回 undefined。 */
function clockOf(value: unknown): string | undefined {
  const total = minutesOf(value);
  return total === undefined ? undefined : pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}

/**
 * 把分钟数写成 `HH:MM`；`1440`（上游用当日 24:00）写成 `24:00`。
 *
 * ⚠️ 不能用 `% 1440`：那会把 `1440` 折成 `00:00`，于是
 * 「22:00–24:00」显示成「22:00–00:00」—— 语义相同但读起来像零长度区间。
 */
function minuteText(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  if (n < 0 || n > 1440) return undefined;
  if (n === 1440) return "24:00";
  return pad(Math.floor(n / 60)) + ":" + pad(n % 60);
}

/**
 * 把一个时段端点归一成「当日分钟数」。
 *
 * 同时接受 `HH:MM` 字符串（Qoder / Buddy）与分钟数（Trae），
 * 这样 {@link isActive} 只有一套算术。
 */
function slotMinutes(value: unknown): number | undefined {
  const fromClock = minutesOf(value);
  if (fromClock !== undefined) return fromClock;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n >= 0 && n <= 1440 ? n : undefined;
}

/** 一个时段端点用于展示的文本（两种形态都认）。 */
function slotText(value: unknown): string | undefined {
  return clockOf(value) ?? minuteText(value);
}

/**
 * 某时刻在指定时区的「分钟数 + ISO 星期几」。
 *
 * ⚠️ 必须用 `Intl` 按 IANA 时区取，不能用 `Date.getHours()`：后者取的是
 * **运行机器**的本地时区，用户在 UTC 机器上跑会让所有窗口整体偏移。
 * 星期用 `Intl` 的 `weekday` 再映射成 **1=周一 … 7=周日**（上游口径）。
 */
function localClock(
  now: Date,
  timezone: string,
): { minutes: number; weekday: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);
    const pick = (type: string) => parts.find((p) => p.type === type)?.value;
    const hour = Number(pick("hour"));
    const minute = Number(pick("minute"));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    const weekdays: Record<string, number> = {
      Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
    };
    const weekday = weekdays[String(pick("weekday"))];
    if (weekday === undefined) return undefined;
    // `Intl` 在 hour12:false 下会把午夜给成 "24"，按 0 处理。
    return { minutes: (hour % 24) * 60 + minute, weekday };
  } catch {
    return undefined;
  }
}

/** 活动的有效期是否覆盖 `now`；未给有效期视为长期有效。 */
function withinValidity(discount: Discount, now: Date): boolean {
  const from = discount.validFrom === undefined ? Number.NaN : Date.parse(discount.validFrom);
  const until = discount.validUntil === undefined ? Number.NaN : Date.parse(discount.validUntil);
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() >= until) return false;
  return true;
}

/**
 * 当前时刻是否落在某个每日时段内（**所有渠道共用的唯一判据**）。
 *
 * 口径：
 * 1. `weekdays` 缺失或为空 ⇒ 每天生效；否则 `weekday` 必须在内（1=周一…7=周日）；
 * 2. `start < end` ⇒ 普通区间；`start > end` ⇒ **跨零点**（如 22:00–02:00）；
 * 3. `end === 1440` ⇒ 到当日 24:00（Trae 用 1440 而非 0）。
 *
 * 无每日时段（`daily` 缺失或全不可解析）⇒ **视为全天生效**：此时有效期
 * 由 {@link withinValidity} 单独判断，两者不重复表达同一件事。
 */
function withinDaily(discount: Discount, now: Date): boolean {
  const slots = discount.daily;
  if (!Array.isArray(slots) || slots.length === 0) return true;
  const clock = localClock(now, discount.timezone ?? DEFAULT_PROMO_TIMEZONE);
  // 时区非法 ⇒ 无法判断 ⇒ 保守按「不在时段内」处理，宁可不显示折扣价。
  if (clock === undefined) return false;
  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null) continue;
    const start = slotMinutes(slot.start);
    const end = slotMinutes(slot.end);
    if (start === undefined || end === undefined || start === end) continue;
    // ⚠️ 星期限制**按每个时段各自判断**：Trae 实测有「工作日三段 + 周末全天」，
    // 合并成一个全局星期集会得到空交集，进而退回「每天」（真实缺陷）。
    const days = slot.weekdays;
    const dayMatches =
      days === undefined || days.length === 0 || days.includes(clock.weekday);
    if (start < end) {
      if (dayMatches && clock.minutes >= start && clock.minutes < end) return true;
      continue;
    }
    // 跨零点：当日 [start, 24:00) 属于「起始日」，[00:00, end) 属于「次日」。
    // 故后者要用**前一天**的星期判断。
    if (dayMatches && clock.minutes >= start) return true;
    const previous = clock.weekday === 1 ? 7 : clock.weekday - 1;
    const previousMatches =
      days === undefined || days.length === 0 || days.includes(previous);
    if (previousMatches && clock.minutes < end) return true;
  }
  return false;
}

/**
 * 折扣此刻是否生效 —— **展示层唯一的「生效」判断**。
 *
 * 两个条件同时成立：有效期覆盖 `now`，且（若有每日时段）此刻落在某个时段内。
 *
 * ⚠️ **判据只来自「窗口 + 当前时刻」，从不来自目录里的「当前价」快照**：
 * Qoder 的 `price_factor`、Trae 的 `consumption_rate`、Buddy 的
 * `discountedCreditsRate` 都只回答「抓取那一刻是多少」，不能回答
 * 「现在算不算」—— 后者是当前时刻的属性。
 */
export function isActive(discount: Discount, now: Date = new Date()): boolean {
  return withinValidity(discount, now) && withinDaily(discount, now);
}

/** 时段文案，如 `23:00–07:50 / 22:00–24:00`；无每日时段时 undefined。 */
function dailyText(discount: Discount): string | undefined {
  if (!Array.isArray(discount.daily) || discount.daily.length === 0) return undefined;
  const parts: string[] = [];
  for (const slot of discount.daily) {
    if (typeof slot !== "object" || slot === null) continue;
    const start = slotText(slot.start);
    const end = slotText(slot.end);
    if (start === undefined || end === undefined) continue;
    const startMinutes = slotMinutes(slot.start);
    const endMinutes = slotMinutes(slot.end);
    const crossesMidnight =
      startMinutes !== undefined && endMinutes !== undefined && startMinutes > endMinutes;
    parts.push(start + "–" + (crossesMidnight ? "次日" : "") + end);
  }
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function numberText(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  // 去掉浮点噪声：0.7500000001 → 0.75，同时保留 0。
  return String(Number(value.toFixed(4)));
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 倍率数值 → 展示文本：`0` 显示「免费」，其余 `x<n>`。 */
function rateOf(value: number | undefined): string | undefined {
  const n = numberText(value);
  if (n === undefined) return undefined;
  return Number(n) === 0 ? "免费" : "x" + n;
}

/** 折扣倍率的展示文本：`免费` 原样，`x0` 归一成「免费」。 */
function promoRateText(rate: string | undefined): string | undefined {
  if (rate === undefined) return undefined;
  if (rate === "免费") return rate;
  const numeric = Number(rate.replace(/^x/, ""));
  return Number.isFinite(numeric) && numeric === 0 ? "免费" : rate;
}

/** 把折扣归一成 `Discount`；判据不成立时 undefined（不编造）。 */
function discount(
  before: unknown,
  after: unknown,
  rest: Omit<Discount, "before" | "after">,
): Discount | undefined {
  const beforeNumber = typeof before === "number" && Number.isFinite(before) && before >= 0 ? before : undefined;
  const afterNumber = typeof after === "number" && Number.isFinite(after) && after >= 0 ? after : undefined;
  // 没有原价就无法表达「省了多少」；没有折后价就没有折扣可言。
  if (beforeNumber === undefined || afterNumber === undefined) return undefined;
  // 必须是真的降价（相等 = 无折扣，实测 `discount: 100` 即为此）。
  if (beforeNumber <= afterNumber) return undefined;
  return { before: beforeNumber, after: afterNumber, ...rest };
}

/* ─────────────────────────── 各驱动 → Discount ─────────────────────────── */

/** Qoder 目录的 `promotion`（错峰折扣）。 */
function qoderDiscount(model: Record<string, unknown>): Discount | undefined {
  const raw = model.promotion;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const start = text(record.windowStart);
  const end = text(record.windowEnd);
  const before = typeof record.beforePromotionPriceFactor === "number"
    ? record.beforePromotionPriceFactor
    : undefined;
  const factor = typeof record.discountFactor === "number"
    ? record.discountFactor
    : undefined;
  // 折后价 = 原价 × 折扣系数。两个都是活动本身的定价参数（与抓取时刻无关），
  // 故**不读** `priceFactor`（那是抓取那一刻的生效价，会过期）。
  const after = before !== undefined && factor !== undefined ? before * factor : undefined;
  return discount(before, after, {
    ...(start !== undefined && end !== undefined
      ? { daily: [{ start, end }] }
      : {}),
    ...text(record.badgeZh) === undefined ? {} : { label: text(record.badgeZh) },
  });
}

/** Buddy / WorkBuddy 目录的 `promotion`（本插件解析层附加）。 */
function buddyDiscount(model: Record<string, unknown>): Discount | undefined {
  const raw = model.promotion;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const daily = Array.isArray(record.daily) ? (record.daily as DailySlot[]) : undefined;
  const label = text(record.label);
  const afterText = promoRateText(text(record.rate));
  const validFrom = text(record.validFrom);
  const validUntil = text(record.validUntil);
  if (daily === undefined && label === undefined && afterText === undefined) return undefined;
  // Buddy 的目录**只下发折后价**（`modelPromotions[].discount.discountedCredits`），
  // 原价在模型的 `creditsRate` 上（那是模型基准价，不是抓取时刻的促销价）。
  // 故这里只交出折后价与窗口，原价由 {@link discountOf} 用 `creditsRate` 补。
  return {
    ...(daily === undefined ? {} : { daily }),
    ...text(record.timezone) === undefined ? {} : { timezone: text(record.timezone) },
    ...label === undefined ? {} : { label },
    ...afterText === undefined ? {} : { afterText },
    ...validFrom === undefined ? {} : { validFrom },
    ...validUntil === undefined ? {} : { validUntil },
  };
}

/** Trae 的时段折扣（`offPeak`，见 vendor 的 `TraeOffPeakDiscount`）。 */
function traeDiscount(model: Record<string, unknown>): Discount | undefined {
  const raw = model.offPeak;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const windows = Array.isArray(record.windows) ? record.windows : undefined;
  if (windows === undefined || windows.length === 0) return undefined;
  const before = typeof record.beforeRate === "number" ? record.beforeRate : undefined;
  const after = typeof record.afterRate === "number" ? record.afterRate : undefined;
  /**
   * ⚠️ **每个窗口各自保留 `weekdays`**（2026-10-24 修正）。
   *
   * 实测 `deepseek-v4.1-flash` 是「工作日三段 + 周末全天」：合并成一个全局
   * 星期集会得到**空交集**，进而退回「每天」—— 周末的全天窗口于是覆盖掉
   * 工作日限制，周一上午也显示折后价。
   */
  const daily: DailySlot[] = [];
  for (const window of windows) {
    if (typeof window !== "object" || window === null) continue;
    const item = window as Record<string, unknown>;
    const start = item.startMinute;
    const end = item.endMinute;
    if (typeof start !== "number" || typeof end !== "number") continue;
    const rawDays = item.weekdays;
    const weekdays = Array.isArray(rawDays)
      ? rawDays.filter(
          (day): day is number =>
            typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7,
        )
      : undefined;
    daily.push({
      start,
      end,
      ...weekdays === undefined || weekdays.length === 0 ? {} : { weekdays },
    });
  }
  if (daily.length === 0) return undefined;
  const timezone = text(record.timezone);
  return discount(before, after, {
    daily,
    ...timezone === undefined ? {} : { timezone },
  });
}

/**
 * 把任意渠道的目录条目归一成 {@link Discount}。
 *
 * 顺序即优先级：**窗口型定价**（原价 + 折后价都来自活动参数）优先于
 * **快照型**（只有「抓取那一刻的当前价」）。
 *
 * @param model 目录快照条目。
 * @returns 无折扣时 `undefined`。
 */
export function discountOf(model: Record<string, unknown> | undefined): Discount | undefined {
  if (!model) return undefined;

  // 1. Trae：错峰折扣（原价 / 折后价 / 窗口都来自活动参数）。
  const trae = traeDiscount(model);
  if (trae !== undefined) return trae;

  // 2. Qoder：错峰折扣（before × factor 得到折后价）。
  const qoder = qoderDiscount(model);
  if (qoder !== undefined) return qoder;

  // 3. Buddy：只有折后价，原价取模型的 `creditsRate`。
  const buddy = buddyDiscount(model);
  if (buddy !== undefined) {
    // ⚠️ 这里用 `creditsRate` 当原价，只在**它确实是原价**时成立：
    // Buddy 的 `creditsRate` 是「不打折时的倍率」，促销价另走
    // `discountedCreditsRate` / `promotion.rate`。两者相等即无折扣。
    const before = typeof model.creditsRate === "string"
      ? Number(model.creditsRate.replace(/^x/, ""))
      : typeof model.creditsRate === "number"
        ? model.creditsRate
        : undefined;
    const after = buddy.afterText === "免费"
      ? 0
      : buddy.afterText === undefined
        ? undefined
        : Number(buddy.afterText.replace(/^x/, ""));
    if (before !== undefined && after !== undefined && Number.isFinite(before) && Number.isFinite(after)) {
      if (before > after) return { ...buddy, before, after };
      // 相等 ⇒ 这个「促销」就是当前价，没有折扣可言。
      return undefined;
    }
    return buddy;
  }

  // 4. Trae 的一次性活动（`limited` / `subsidy`，无每日时段）。
  //
  // ⚠️ 原价与折后价由 vendor 的 `readActivityDiscount` **成对**填充
  // （`originalCreditsRate` 只在「此刻确实生效」时写），故这里可以用
  // `original > current` 判定。一次活动的终点是 `discountEndsAtSec`。
  const original = typeof model.originalCreditsRate === "number"
    ? model.originalCreditsRate
    : undefined;
  const current = typeof model.creditsRate === "number" ? model.creditsRate : undefined;
  if (original !== undefined && current !== undefined && original > current) {
    const endsAt = typeof model.discountEndsAtSec === "number" ? model.discountEndsAtSec : undefined;
    return {
      before: original,
      after: current,
      ...(endsAt === undefined
        ? {}
        : { validUntil: new Date(endsAt * 1000).toISOString() }),
    };
  }

  return undefined;
}

/**
 * 模型计费系数的主文案。
 *
 * **按窗口推算**（统一口径，2026-10-24）：折扣只在 {@link isActive} 为真时
 * 展开成 `原价→折后价`，否则只报原价 —— 避免在窗口外让用户按折后价预期。
 *
 * - Qoder：`0.5×` / `0×`；
 * - CodeBuddy：`x0.29`，有折扣时 `x0.29→x0.50`；
 * - Trae：`x0.2`，有折扣时 `x0.2→x0.1`。
 *
 * 无折扣信息时返回**目录此刻声明的单价**（不推算，也不补 `x1`）。
 */
export function rateLabel(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;

  const found = discountOf(model);
  if (found !== undefined) {
    const beforeText = rateOf(found.before);
    const afterText = rateOf(found.after) ?? found.afterText;
    if (beforeText !== undefined) {
      if (afterText !== undefined && isActive(found, now)) {
        return beforeText + "→" + afterText;
      }
      return beforeText;
    }
  }

  // 无折扣：报目录声明的单价。
  // Qoder：`price_factor` 是当前倍率，`0` 代表免费。
  const price = numberText(model.priceFactor);
  if (price !== undefined) return price + "×";

  // CodeBuddy / WorkBuddy：字符串倍率。
  const creditsText = text(model.creditsRate);
  if (creditsText !== undefined) return creditsText;

  // Trae：数字倍率，`0` 显示「免费」。
  const credits = numberText(model.creditsRate);
  if (credits !== undefined) return rateOf(Number(credits));

  // Raccoon 一类驱动可能直接给出生效价/原价字段。
  const effective = numberText(model.effectiveMultiplier);
  if (effective !== undefined) return "x" + effective;

  return undefined;
}

/**
 * 时段类活动的短标签（夜间免费 / 夜间半价 / 错峰折扣）。
 *
 * 只描述**目录确实下发的**角标与折扣，不推断「夜间」这类语义。
 * 文案要保持**短**：它和倍率标签并排放在模型行里，宽度有限。
 * 完整时段（`23:00–08:00`）由 {@link promotionWindow} 提供，进 `title`。
 *
 * ⚠️ **窗口外也要给标签**（带「未生效」后缀）：用户需要知道「有这个活动、
 * 现在不算」才能安排使用时间。把它藏起来等于活动不可发现。
 */
export function promotionNote(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;
  const found = discountOf(model);
  if (found === undefined) return undefined;
  const active = isActive(found, now);
  const window = dailyText(found);

  // 角标文案优先（服务端下发的就是用户该看到的措辞）。
  //
  // ⚠️ 「未生效」后缀**只对循环时段有意义**：一次性活动过期就是没了，
  // 再挂一个「已过有效期」的标签只是噪声。
  const label = found.label;
  if (label !== undefined) {
    if (active) return label;
    return window === undefined ? undefined : label + "（未生效）";
  }

  // 循环时段（错峰）：白天也要看得到，否则活动不可发现。
  if (window !== undefined) return active ? "错峰" : "错峰（未生效）";

  // 一次性活动：截止时间是用户唯一能安排的信息，短到可以进 chip。
  const deadline = deadlineText(found, now);
  return active ? (deadline === undefined ? undefined : "限时折扣至 " + deadline) : undefined;
}

/** 一次性活动的截止时间文案（`MM-DD HH:MM`）；无有效期或已过期时 undefined。 */
function deadlineText(discount: Discount, now: Date): string | undefined {
  if (discount.validUntil === undefined) return undefined;
  const at = new Date(discount.validUntil);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return undefined;
  return (
    pad(at.getMonth() + 1) +
    "-" +
    pad(at.getDate()) +
    " " +
    pad(at.getHours()) +
    ":" +
    pad(at.getMinutes())
  );
}

/**
 * 活动的完整时段文案（`23:00–08:00`，多条用 ` / ` 连接）。
 *
 * 与 {@link promotionNote} 分开：标签里放不下，但 `title` 与说明里需要完整信息，
 * 否则用户看不出「夜间」到底指几点到几点。
 *
 * ⚠️ **不受「此刻是否生效」影响**：用户需要知道「几点到几点打折」才能安排。
 */
export function promotionWindow(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;
  const found = discountOf(model);
  if (found === undefined) return undefined;
  // 循环时段优先：它是用户安排使用时间的依据。
  const window = dailyText(found);
  if (window !== undefined) return window;
  // 一次性活动只有截止时间。
  const deadline = deadlineText(found, now);
  return deadline === undefined ? undefined : "至 " + deadline;
}
