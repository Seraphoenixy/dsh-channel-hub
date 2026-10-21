/**
 * CodeBuddy / WorkBuddy 的**限时/限时段折扣**（夜间免费、夜间半价一类）。
 *
 * ## 为什么单独解析
 *
 * `vendor/ofm` 的 `parsePromotions` 只回答「此刻折后价是多少」，把
 * `schedule`（每日时段）与 `badge`（角标文案，实测「夜间折扣」）丢掉了 ——
 * 它服务于「模型菜单名字里拼折后价」，不需要解释折扣**什么时候**生效。
 * 本插件要展示「夜间免费 23:00–07:50」这类信息，故在**同一次** `/v3/config`
 * 响应上另做一次解析：不新增端点、不改 vendor 快照（`sources.json` 的哈希
 * 仍与上游一致），只复用已经拿到的响应体。
 *
 * ## 真实结构（实测，`data.modelPromotions`）
 *
 * ```json
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough", "factor": 0.5 },
 *    "badge": { "color": "#1E90FF", "label": "夜间折扣" },
 *    "schedule": { "daily": [{ "start": "23:00", "end": "7:50" }], "timezone": "Asia/Shanghai" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 *
 * ## 必须保留的退化情形
 *
 * - `enabled: false` —— 已停用，跳过；
 * - `factor: 0` —— **真的免费**（不是「活动已结束」），但必须带时间窗口，
 *   无窗口的 `0x` 视为遗留占位；
 * - `discountedCredits` 的 `"0.50x"`（x 在后）与 `"x0.50"`（x 在前）两种写法；
 * - 同一模型命中多条 —— 取 `priority` 最高者。
 *
 * 与 OFM 不同的一点：这里**不按「此刻是否生效」过滤**。时段与角标本身就是
 * 用户要的信息（「夜间免费」在白天也该看到），是否生效由展示层按当前时间
 * 推算（见 `core/rate.ts`）。
 */

/** 每日时段（`HH:MM`，允许跨零点）。 */
export interface PromotionSlot {
  start?: unknown;
  end?: unknown;
}

/** 单个模型上的折扣活动。 */
export interface ModelPromotion {
  /** 每日时段；缺失表示不限时段（可能只有有效期）。 */
  daily?: PromotionSlot[];
  /** 时段时区（IANA，实测 `Asia/Shanghai`）。 */
  timezone?: string;
  /** 有效期起点（ISO）。 */
  validFrom?: string;
  /** 有效期终点（ISO）。 */
  validUntil?: string;
  /** 服务端角标文案，如「夜间折扣」。 */
  label?: string;
  /** 生效时的倍率文本，如 `免费` / `x0.50`。 */
  rate?: string;
}

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * 归一化 `discountedCredits`：`"0.50x"` / `"x0.50"` / `"x0.03 credits"` → `"x0.50"`。
 *
 * 两种写法都接受（上游同一后端确实两套并存），解析不出返回 undefined，
 * **不回退成 `x1`**：编造倍率比不显示更糟。
 */
export function normalizePromotionRate(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  // 去掉可能的单位后缀（如 "x0.03 credits"）。
  const head = raw.split(/\s+/)[0] ?? "";
  const match = /^x(\d+(?:\.\d+)?)$/i.exec(head) ?? /^(\d+(?:\.\d+)?)x$/i.exec(head);
  return match?.[1] === undefined ? undefined : "x" + match[1];
}

const priorityOf = (item: Record<string, unknown>): number =>
  typeof item.priority === "number" && Number.isFinite(item.priority)
    ? item.priority
    : 0;

/**
 * 从 `/v3/config` 响应体提取「模型 id → 折扣活动」。
 *
 * 只读取 `data.modelPromotions`；结构不符或没有该字段时返回空表 —— 促销
 * 只是展示增强，任何解析问题都不该影响模型目录本身。
 */
export function promotionsFromConfig(body: unknown): Map<string, ModelPromotion> {
  const result = new Map<string, ModelPromotion>();
  if (typeof body !== "object" || body === null) return result;
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return result;
  const list = (data as Record<string, unknown>).modelPromotions;
  if (!Array.isArray(list)) return result;

  // 升序写入，使高 priority 覆盖低 priority（与 OFM 同向）。
  const sorted = [...list].sort(
    (a, b) =>
      priorityOf((a ?? {}) as Record<string, unknown>) -
      priorityOf((b ?? {}) as Record<string, unknown>),
  );
  const chosen = new Map<string, number>();

  for (const item of sorted) {
    if (typeof item !== "object" || item === null) continue;
    const promotion = item as Record<string, unknown>;
    if (promotion.enabled === false) continue;
    const discount = promotion.discount;
    if (typeof discount !== "object" || discount === null) continue;
    const detail = discount as Record<string, unknown>;

    const schedule =
      typeof promotion.schedule === "object" && promotion.schedule !== null
        ? (promotion.schedule as Record<string, unknown>)
        : undefined;
    const daily = Array.isArray(schedule?.daily)
      ? (schedule.daily as PromotionSlot[])
      : undefined;
    const timezone = text(schedule?.timezone);
    const validFrom = text(schedule?.validFrom);
    const validUntil = text(schedule?.validUntil);
    const windowed =
      (daily !== undefined && daily.length > 0) ||
      validFrom !== undefined ||
      validUntil !== undefined;

    const factor = typeof detail.factor === "number" ? detail.factor : undefined;
    let rate: string | undefined;
    if (factor === 0) {
      // 免费额度必然是限时的：没有窗口的 `0x` 更可能是遗留占位。
      if (!windowed) continue;
      rate = "免费";
    } else {
      rate = normalizePromotionRate(detail.discountedCredits);
      if (rate === "x0") continue;
    }
    if (rate === undefined) continue;

    const badge =
      typeof promotion.badge === "object" && promotion.badge !== null
        ? (promotion.badge as Record<string, unknown>)
        : undefined;
    const label = text(badge?.label) ?? text(badge?.zh);

    const modelIds = promotion.modelIds;
    if (!Array.isArray(modelIds)) continue;
    const priority = priorityOf(promotion);
    for (const id of modelIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      const previous = chosen.get(id);
      if (previous !== undefined && previous > priority) continue;
      chosen.set(id, priority);
      result.set(id, {
        ...(daily === undefined ? {} : { daily }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(validFrom === undefined ? {} : { validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }),
        ...(label === undefined ? {} : { label }),
        rate,
      });
    }
  }
  return result;
}
