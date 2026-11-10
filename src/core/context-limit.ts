/**
 * 全局「单次请求输入预算」的换算与展示口径。
 *
 * ## 为什么需要换算，而不是直接把窗口改成一个数
 *
 * DSH 只认适配器声明的 `context.contextWindow`，并把它当作**请求 + 响应
 * 合计**的容量（`dsh-llm` 的 `LlmModelContext`）。宿主的自动压缩按
 * `dsh-compaction-basic` 的公式决定「什么时候压」：
 *
 * ```
 * reserved = 请求 maxTokens ?? 适配器 defaultMaxTokens ?? 0
 * messageBudget  = contextWindow - reserved
 * pressureBudget = messageBudget - headroomTokens（默认 65536）
 * threshold      = min(contextWindow × 0.8, pressureBudget)
 * ```
 *
 * 所以**同一个窗口数字**在不同模型上的实际输入预算完全不同：窗口 256K 时，
 * 未声明输出预留的模型压缩点约 192K，而声明 128K 输出预留的模型只有约 67K
 * （差近 3 倍）。要让「设一个预算」在各模型上含义一致，只能按每个模型自己的
 * 输出预留**反算**窗口：
 *
 * ```
 * report = min(上游窗口, 预算 + 模型输出预留 + headroom)
 * ```
 *
 * 上游窗口更小时 `min` 生效 —— 该模型保持原值，预算不会把窗口放大。
 *
 * ## 边界
 *
 * - 预算为 `undefined`（用户选「跟随上游」）时**原样返回**，不改变任何行为；
 * - 上游窗口缺失或非法时同样原样返回，不编造容量；
 * - 这里只算「该报多少」，不改适配器的输出预留（`defaultMaxTokens`），
 *   否则会削掉上游的输出能力。
 */

/** 宿主的默认压缩余量（`dsh-compaction-basic` 的 `headroomTokens`）。 */
export const CONTEXT_BUDGET_HEADROOM = 65_536;

/** 宿主的默认压缩阈值比例（`dsh-compaction-basic` 的 `thresholdRatio`）。 */
export const CONTEXT_BUDGET_RATIO = 0.8;

/**
 * 固定档位：512K / 768K / 1M（256K 步长）。
 *
 * 只做离散档位，不做任意数字输入：数值一旦可填，就要额外回答
 * 「低于输出预留时怎么办」「与 headroom 的余量」这些边界。档位下限取
 * 512K —— 本插件接入的模型常规档普遍在 200K 以上，低于 512K 的档位会把
 * 压缩点压到接近输出预留，实际不可用；上限取 1M —— 当前目录里最大的窗口
 * 是 1,048,576，更高的档位等同「跟随上游」，没有区分意义。
 */
export const CONTEXT_BUDGET_TIERS: readonly number[] = [
  524_288, 786_432, 1_048_576,
];

/** 正整数形式的窗口值；其余（缺失、0、负数、非数字）返回 `undefined`。 */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/** 是否是可发布的预算档位。 */
export function isContextBudgetTier(value: unknown): value is number {
  return typeof value === "number" && CONTEXT_BUDGET_TIERS.includes(value);
}

/**
 * 归一化持久化值。
 *
 * `null` / `undefined` 表示「跟随上游」；不是档位的值一律按「跟随上游」处理
 *
 * —— 旧版本写坏的键不该让所有模型失去窗口。
 */
export function normalizeContextBudget(value: unknown): number | undefined {
  return isContextBudgetTier(value) ? value : undefined;
}

/**
 * 按预算算出要上报给 DSH 的窗口。
 *
 * @param upstream 上游/目录声明的窗口（正整数）。
 * @param reserved 该模型的输出预留 token（`defaultMaxTokens`，缺失按 0）。
 * @param budget 全局输入预算；`undefined` = 跟随上游。
 * @returns 上报窗口；上游值非法时原样返回（不编造）。
 */
export function limitedContextWindow(
  upstream: unknown,
  reserved: unknown,
  budget: number | undefined,
): number | undefined {
  const window = positive(upstream);
  if (budget === undefined || !isContextBudgetTier(budget)) return window;
  if (window === undefined) return undefined;
  const output = Math.max(0, positive(reserved) ?? 0);
  return Math.min(window, budget + output + CONTEXT_BUDGET_HEADROOM);
}

/**
 * 宿主按默认策略会在这个窗口上触发的压缩点（用于界面展示的估算值）。
 *
 * 与 `dsh-compaction-basic` 的 `resolveCompactSpec` 同式；窗口或余量不足时
 * 返回 `undefined`（宿主在这种情况下会拒绝该目标，界面不应显示一个数字）。
 */
export function estimatedCompactionTokens(
  window: unknown,
  reserved: unknown,
): number | undefined {
  const total = positive(window);
  if (total === undefined) return undefined;
  const output = Math.max(0, positive(reserved) ?? 0);
  const messageBudget = total - output;
  if (messageBudget <= 0) return undefined;
  const pressureBudget = messageBudget - CONTEXT_BUDGET_HEADROOM;
  if (pressureBudget <= 0) return undefined;
  return Math.floor(Math.min(total * CONTEXT_BUDGET_RATIO, pressureBudget));
}

/**
 * 目录条目的输出预留（展示侧用它反算窗口）。
 *
 * ⚠️ 展示侧只有目录字段，没有适配器的 `defaultMaxTokens`：两者在个别渠道
 * 可能不同（如 Trae 开大窗口档时的 `maxModeOutputTokens`）。这里的取值只
 * 影响**界面显示的数字**，权威值由 `resolveModel` 用适配器返回值计算。
 */
export function catalogReservedTokens(
  model: Record<string, unknown> | undefined,
  extended = false,
): number {
  const base =
    positive(model?.maxOutputTokens) ?? positive(model?.maxTokens) ?? 0;
  if (!extended) return base;
  return positive(model?.maxModeOutputTokens) ?? base;
}

/**
 * 渠道中心展示用的模型副本：窗口按预算钳制，并保留上游原值供界面说明。
 *
 * - 钳制后与上游相同则**不写**额外字段（界面据此不显示“限制”提示）；
 * - `maxContextWindow` 同受全局上限约束：被压到不大于常规档时，
 *   `contextTier` 自然不再认作「另一档」，档位徽标随之消失。
 */
export function displayLimitedModel(
  model: Record<string, unknown>,
  budget: number | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...model };
  const base = positive(model.contextWindow);
  if (base !== undefined) {
    const reserved = catalogReservedTokens(model);
    const limited = limitedContextWindow(base, reserved, budget);
    // 只有**确实被收紧**时才带额外字段：未设置预算、或上游窗口更小的模型
    // 与上游一致，界面不该给它们加一行“限制”说明。
    if (limited !== undefined && limited !== base) {
      next.contextWindow = limited;
      next.upstreamContextWindow = base;
      const compactAt = estimatedCompactionTokens(limited, reserved);
      if (compactAt !== undefined) next.estimatedCompactionTokens = compactAt;
    }
  }
  const extended = positive(model.maxContextWindow);
  if (extended !== undefined) {
    const reserved = catalogReservedTokens(model, true);
    const limited = limitedContextWindow(extended, reserved, budget);
    if (limited !== undefined && limited !== extended) {
      next.maxContextWindow = limited;
      next.upstreamMaxContextWindow = extended;
    }
  }
  return next;
}
