/**
 * 模型计费系数的展示文案。
 *
 * 各驱动把倍率放在不同字段里，且数字/字符串形态不一：
 * - Qoder：`priceFactor`（数字，目录 `price_factor`，`0` 是合法免费倍率），
 *   活动折扣在 `promotion`（`discountFactor` / `beforePromotionPriceFactor` /
 *   `windowStart` / `windowEnd` / `badgeZh`）；
 * - CodeBuddy / WorkBuddy：`creditsRate`（字符串 `x0.29`），促销价在
 *   `discountedCreditsRate`（如 `x0.50` 或 `免费`），活动时段在 `promotion`；
 * - Trae：`creditsRate` / `originalCreditsRate`（数字，来自消耗倍率注册表），
 *   限时活动终点在 `discountEndsAtSec`。
 *
 * 这里只做展示归一化，**不编造**：字段缺失或不是有限数时返回 `undefined`，
 * 由调用方决定不渲染，而不是补一个 `x1`。`0` 必须原样显示（免费也是倍率）。
 *
 * 形态与 OFM 及 dsh-workbuddy-trae-qoder-connect 的既有展示保持一致：
 * Qoder 用 `0.5×`，其余用 `x0.5`，促销用 `原价→折后价`。倍率只属于展示语境，
 * 不参与请求或计费计算。
 *
 * ## 时段类活动（夜间免费 / 夜间半价）
 *
 * 目录里的折扣**不是全天生效**：CodeBuddy 的 `modelPromotions[].schedule` 带
 * 每日时段（实测 `23:00–7:50`，时区 `Asia/Shanghai`）与角标文案（「夜间免费」），
 * Qoder 的 `promotion` 带 `windowStart`/`windowEnd`（实测 `22:00–08:00`）与
 * `badgeZh`（「错峰 4 折」）。
 *
 * ⚠️ **倍率本身不按窗口推算**：`rateLabel` 只做字段归一化，倍率就是目录此刻
 * 声明的值，一天里保持稳定。**什么时候生效**由 {@link promotionNote} 单独表达
 * （「夜间折扣 23:00–07:50」）—— 那是用户真正要判断的信息，也让倍率不必因为
 * 读取时刻不同而跳变。
 */

/** 每日时段（`HH:MM`，支持跨零点）。 */
export interface DailySlot {
  start?: unknown;
  end?: unknown;
}

/** 一个折扣活动的时段与文案（各驱动字段已在此归一）。 */
export interface PromotionWindow {
  /** 每日时段；缺失表示不限时段。 */
  daily?: readonly DailySlot[];
  /** 时段时区（IANA）；缺失按 `Asia/Shanghai`。 */
  timezone?: string;
  /** 有效期起点（ISO）。 */
  validFrom?: string;
  /** 有效期终点（ISO）。 */
  validUntil?: string;
  /** 角标文案，如「夜间折扣」「错峰 4 折」。 */
  label?: string;
  /** 生效时的倍率文本，如 `免费` / `x0.50`。 */
  rate?: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

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

/** 活动的有效期是否覆盖 `now`；未给有效期视为长期有效。 */
function withinValidity(promo: PromotionWindow, now: Date): boolean {
  const from = promo.validFrom === undefined ? Number.NaN : Date.parse(promo.validFrom);
  const until = promo.validUntil === undefined ? Number.NaN : Date.parse(promo.validUntil);
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() >= until) return false;
  return true;
}

/** 时段文案，如 `23:00–07:50`；无每日时段时 undefined。 */
function dailyText(promo: PromotionWindow): string | undefined {
  if (!Array.isArray(promo.daily)) return undefined;
  const parts: string[] = [];
  for (const slot of promo.daily) {
    if (typeof slot !== "object" || slot === null) continue;
    const start = clockOf(slot.start);
    const end = clockOf(slot.end);
    if (start === undefined || end === undefined) continue;
    parts.push(start + "–" + end);
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

/** Qoder 目录的 `promotion` 对象。 */
interface QoderPromotion extends PromotionWindow {
  start?: string;
  end?: string;
  before?: number;
  discount?: number;
  active?: boolean;
}

function qoderPromotion(model: Record<string, unknown>): QoderPromotion | undefined {
  const raw = model.promotion;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const start = text(record.windowStart);
  const end = text(record.windowEnd);
  const before = typeof record.beforePromotionPriceFactor === "number"
    ? record.beforePromotionPriceFactor
    : undefined;
  const discount = typeof record.discountFactor === "number"
    ? record.discountFactor
    : undefined;
  const label = text(record.badgeZh);
  if (start === undefined && end === undefined && before === undefined && label === undefined)
    return undefined;
  return {
    start,
    end,
    before,
    discount,
    active: record.active === true,
    label,
    daily:
      start !== undefined && end !== undefined
        ? [{ start, end }]
        : undefined,
  };
}

/** Buddy / WorkBuddy 目录的 `promotion`（本插件解析层附加，见 vendor/ofm/src/buddy.ts）。 */
function buddyPromotion(model: Record<string, unknown>): PromotionWindow | undefined {
  const raw = model.promotion;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const daily = Array.isArray(record.daily)
    ? (record.daily as DailySlot[])
    : undefined;
  const label = text(record.label);
  const rate = text(record.rate);
  const validFrom = text(record.validFrom);
  const validUntil = text(record.validUntil);
  if (daily === undefined && label === undefined && rate === undefined) return undefined;
  return {
    daily,
    timezone: text(record.timezone),
    label,
    rate,
    validFrom,
    validUntil,
  };
}

/** 折扣倍率的展示文本：`0` 显示「免费」，其余 `x<n>`。 */
function promoRateText(rate: string | undefined): string | undefined {
  if (rate === undefined) return undefined;
  if (rate === "免费") return rate;
  const numeric = Number(rate.replace(/^x/, ""));
  return Number.isFinite(numeric) && numeric === 0 ? "免费" : rate;
}

/**
 * 模型计费系数的主文案。
 *
 * **不按时间窗口推算**：这里只做字段归一化，倍率就是目录此刻声明的值；
 * 「夜间 / 错峰」这类**什么时候生效**的信息由 {@link promotionNote} 单独给出，
 * 两者互不替代。倍率因此在一天里保持稳定，不随读取时刻跳变。
 *
 * - Qoder：`priceFactor` → `0.5×` / `0×`；
 * - CodeBuddy：`creditsRate`，有折扣时 `原价→折后价`；
 * - Trae：数字倍率，折扣时 `x原→x折`，`0` 显示「免费」。
 */
export function rateLabel(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;

  // Qoder：目录里的 price_factor 就是当前倍率，0 代表免费。不按窗口推算。
  const price = numberText(model.priceFactor);
  if (price !== undefined) return price + "×";

  // CodeBuddy / WorkBuddy：字符串倍率。
  //
  // 折扣有两个来源，都要认：`promotion.rate` 是本插件在目录响应上补的
  // （不受抓取时刻影响，白天抓目录也留得住夜间免费），
  // `discountedCreditsRate` 是 OFM 按「抓取那一刻是否生效」写下的。
  const creditsText = text(model.creditsRate);
  if (creditsText !== undefined) {
    const promo = buddyPromotion(model);
    const promoRate =
      promo !== undefined && withinValidity(promo, now)
        ? promoRateText(promo.rate)
        : undefined;
    const discounted = promoRate ?? text(model.discountedCreditsRate);
    if (discounted === undefined || discounted === creditsText) return creditsText;
    return creditsText + "→" + discounted;
  }

  // Trae：数字倍率，促销时给出原价→折后价；0 与 OFM 一致显示「免费」。
  const credits = numberText(model.creditsRate);
  if (credits !== undefined) {
    const current = credits === "0" ? "免费" : "x" + credits;
    const original = numberText(model.originalCreditsRate);
    if (original !== undefined && Number(original) > Number(credits))
      return "x" + original + "→" + current;
    return current;
  }

  // Raccoon 一类驱动可能直接给出生效价/原价字段。
  const effective = numberText(model.effectiveMultiplier);
  if (effective !== undefined) {
    const base = numberText(model.baseMultiplier);
    if (base !== undefined && Number(base) > Number(effective))
      return "x" + base + "→x" + effective;
    return "x" + effective;
  }

  return undefined;
}

/**
 * 时段类活动的短标签（夜间免费 / 夜间半价 / 错峰折扣）。
 *
 * 只描述**目录确实下发的**角标与折扣，不推断「夜间」这类语义。
 * 文案要保持**短**：它和倍率标签并排放在模型行里，宽度有限。
 * 完整时段（`23:00–08:00`）由 {@link promotionWindow} 提供，进 `title`。
 *
 * - CodeBuddy：角标（`夜间免费`）优先，无角标时退回时段；
 * - Qoder：`badgeZh`（`错峰 4 折`），无角标时用时段 + 折扣；
 * - Trae：`限时折扣至 MM-DD HH:MM`（只有终点，没有每日时段）。
 *
 * 活动已过有效期、或没有任何可展示的角标/时段时返回 undefined。
 */
export function promotionNote(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;

  const qoder = qoderPromotion(model);
  if (qoder !== undefined) {
    if (!withinValidity(qoder, now)) return undefined;
    if (qoder.label !== undefined) return qoder.label;
    const window = dailyText(qoder);
    if (window === undefined) return undefined;
    const discount = qoder.discount;
    return discount !== undefined
      ? window + " " + Math.round(discount * 100) / 10 + " 折"
      : window;
  }

  const buddy = buddyPromotion(model);
  if (buddy !== undefined) {
    if (!withinValidity(buddy, now)) return undefined;
    // 模型列表是单列，宽度够：角标 + 时段一起给（`夜间折扣 23:00–07:50`）。
    const label = buddy.label;
    const window = dailyText(buddy);
    if (label !== undefined)
      return window === undefined || label.includes(window)
        ? label
        : label + " " + window;
    return window ?? promoRateText(buddy.rate);
  }

  const endsAt = model.discountEndsAtSec;
  if (typeof endsAt === "number" && Number.isFinite(endsAt) && endsAt > 0) {
    const at = new Date(endsAt * 1000);
    if (at.getTime() <= now.getTime()) return undefined;
    const stamp =
      pad(at.getMonth() + 1) +
      "-" +
      pad(at.getDate()) +
      " " +
      pad(at.getHours()) +
      ":" +
      pad(at.getMinutes());
    return "限时折扣至 " + stamp;
  }

  return undefined;
}

/**
 * 活动的完整时段文案（`23:00–08:00`，多条用 ` / ` 连接）。
 *
 * 与 {@link promotionNote} 分开：标签里放不下，但 `title` 与说明里需要完整信息，
 * 否则用户看不出「夜间」到底指几点到几点。
 */
export function promotionWindow(
  model: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!model) return undefined;
  const qoder = qoderPromotion(model);
  if (qoder !== undefined)
    return withinValidity(qoder, now) ? dailyText(qoder) : undefined;
  const buddy = buddyPromotion(model);
  if (buddy !== undefined)
    return withinValidity(buddy, now) ? dailyText(buddy) : undefined;
  return undefined;
}
