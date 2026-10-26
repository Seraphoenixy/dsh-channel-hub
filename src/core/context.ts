/**
 * 上下文档位的**展示**归一化（不参与请求，也不参与计费）。
 *
 * ## 为什么需要它
 *
 * 2026-10-24 之前，「这个模型现在用哪一档上下文」在界面上完全不可见：
 *
 * - Trae 的 `max_mode` 档（1M）与常规 `dev` 档（200K/256K）**计费倍率不同**
 *   （上游按 `strategy=max` 单独计价），而目录只下发**一个** `consumption_rate`
 *   —— 界面显示 x0.08、实际可能按另一档扣额度；
 * - 其余渠道（qoder / buddy / loomy / raccoon）的 `contextWindow` 只是宿主元数据，
 *   用户在渠道中心看不到自己实际拿到多少窗口。
 *
 * 故这里把「模型声明的窗口」与「另一档窗口」整理成一句短文案。判据只有两个
 * 事实：`contextWindow`（常规档）与 `maxContextWindow`（另一档），都来自目录。
 *
 * ## 三条口径
 *
 * 1. **不编造**：字段缺失就返回 `undefined`，界面不渲染，而不是补一个 1M；
 * 2. **只有真正更大才算一档**：实测存在 `maxContextWindow === contextWindow`
 *    （`Doubao-Seed-2.1-Turbo` 256K/256K），那不是两个档位，不能标「1M」；
 * 3. **「能力」与「当前是否启用」分开**：模型能不能走 Max 由目录决定，
 *    走不走由渠道开关决定。两者混在一句文案里会让用户分不清
 *    「这个模型不支持」和「我没打开」。
 */

/** 窗口数值 → 短文案（`1M` / `200K` / `202752`）。 */
export function tokenText(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  const n = Math.trunc(value);
  // 只有恰好是 1000 / 1024 的整数倍时才用 K/M 缩写，避免把 202752 说成 203K
  // （那是个精确值，四舍五入会让用户以为窗口是整数档）。
  if (n % 1_000_000 === 0) return n / 1_000_000 + "M";
  if (n % 1_048_576 === 0) return n / 1_048_576 + "M";
  if (n % 1_000 === 0) return n / 1_000 + "K";
  if (n % 1024 === 0) return n / 1024 + "K";
  return String(n);
}

/** 一个模型的上下文档位（只含目录确实声明的窗口）。 */
export interface ContextTier {
  /** 常规档窗口（`contextWindow`）。 */
  base?: number;
  /** 另一档窗口（Trae 的 `maxContextWindow`），且**必须大于**常规档。 */
  extended?: number;
}

/**
 * 读出模型的档位。
 *
 * @param model 目录快照里的模型条目。
 * @returns 没有任何窗口信息时返回 `undefined`。
 */
export function contextTier(
  model: Record<string, unknown> | undefined,
): ContextTier | undefined {
  if (!model) return undefined;
  const positive = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
  const base = positive(model.contextWindow);
  const rawMax = positive(model.maxContextWindow);
  // 只有严格更大才算「另一档」：相等或更小都只是同一个窗口的两种写法。
  const extended =
    rawMax !== undefined && (base === undefined || rawMax > base)
      ? rawMax
      : undefined;
  if (base === undefined && extended === undefined) return undefined;
  return {
    ...(base === undefined ? {} : { base }),
    ...(extended === undefined ? {} : { extended }),
  };
}

/**
 * 模型菜单里的短后缀（拼进 `name`）。
 *
 * DSH 的模型切换菜单**只渲染 `name`**（`description` 完全不读），故档位必须
 * 进名字才看得见 —— 与倍率同一条理由（见 `vendor/ofm/src/trae-adapter.ts`
 * 的 `traeDisplayName`）。
 *
 * @param model 目录条目。
 * @param extendedEnabled 该渠道的「大窗口档」开关是否打开。
 * @returns 如 `1M`；未启用或模型没有另一档时 `undefined`（不加任何后缀）。
 */
export function extendedTierLabel(
  model: Record<string, unknown> | undefined,
  extendedEnabled: boolean,
): string | undefined {
  if (!extendedEnabled) return undefined;
  const tier = contextTier(model);
  if (tier?.extended === undefined) return undefined;
  return tokenText(tier.extended);
}

/**
 * 渠道中心模型行的档位徽标。
 *
 * 与 {@link extendedTierLabel} 的区别：这里**始终**返回「能力」信息，
 * 并用 `active` 区分「已启用 / 未启用」，让用户知道有个更大的档位可以开。
 *
 * @param model 目录条目。
 * @param extendedEnabled 该渠道的「大窗口档」开关是否打开。
 * @returns `{ label, title, active }`；模型只有一档时 `undefined`。
 */
export function extendedTierBadge(
  model: Record<string, unknown> | undefined,
  extendedEnabled: boolean,
): { label: string; title: string; active: boolean } | undefined {
  const tier = contextTier(model);
  if (tier?.extended === undefined) return undefined;
  const label = tokenText(tier.extended);
  if (label === undefined) return undefined;
  const base = tokenText(tier.base) ?? "未知";
  return {
    label,
    active: extendedEnabled,
    title: extendedEnabled
      ? `当前使用 ${label} 档（常规档 ${base}）；该档计费倍率可能高于常规档`
      : `该模型支持 ${label} 档（常规档 ${base}），当前未启用；开启后计费倍率可能高于常规档`,
  };
}

/**
 * 常规档窗口的短文案（渠道中心里给「没开大档」的模型一个说明）。
 *
 * @param model 目录条目。
 * @returns 如 `200K`；没有窗口信息时 `undefined`。
 */
export function baseContextLabel(
  model: Record<string, unknown> | undefined,
): string | undefined {
  return tokenText(contextTier(model)?.base);
}
