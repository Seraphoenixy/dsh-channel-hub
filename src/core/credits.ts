/**
 * 额度读数的展示归一化（宿主侧）。
 *
 * 各渠道的额度接口返回的形状**完全不同**，而界面只有一种卡片。做法沿用
 * `dsh-workbuddy-trae-qoder-connect` 的思路（`lib/panel.js` 的 `creditsOf`）：
 * **读数文案在宿主侧拼好**（`{ label, progress, packages, error }`），浏览器
 * 只负责画，不做业务判断。否则「什么算 0、什么算查不到、两个包要不要相加」
 * 会在两端各写一遍，然后漂移。
 *
 * 归一化的输入是 `src/drivers/ofm.js` 里 `driver.balance` 的**原样返回值**：
 *
 * | 渠道 | 形状 |
 * |---|---|
 * | buddy / workbuddy / qoder / trae / lobsterai / loomy / raccoon | `CreditBalance` |
 * | gemini | `{ balance, error?, tier? }` |
 * | codearts | `CodeArtsAccountInfo`（积分账户才带 `credit`） |
 *
 * 三条硬规则（与 vendor 的既有约定同源，见 `vendor/ofm/src/credits.ts`）：
 *
 * 1. **查不到 ≠ 0**：`null`、`undefined` 或无法识别的响应一律给 `error`，
 *    绝不显示成「0 积分」——那会被读成「额度用光了」，把用户引向错误的排查
 *    方向（vendor 的 `fetch*CreditBalance` 用 `null` 表达失败正是为此）。
 * 2. **单位不合并**：`token` 与积分不互相折算，`1 亿 token` 不能标成
 *    「1 亿积分」（真实报障）；混单位时逐单位给读数，不给合计与进度。
 * 3. **面值未知不补 100%**：`total <= 0` 时不给进度条，只给「剩余 N」。
 *    补一个 100% 等于宣称一个自己并不知道的满额。
 *    例外是**全零占位包**（`total`/`used`/`remaining` 全为 0，如 Qoder 免费档
 *    的 `套餐额度`）：它既没有余额也没有用量，不构成「一个额度未知的包」，
 *    因此不否决同账号里真正有面值的包（见 `summarize` 的 `informative`）。
 *
 * 另：失效包（`active === false`）的余额**不计入** `total`，单独汇总到
 * `expiredTotal` 供界面提示「另有 N 已失效」——服务端仍会返回那部分数字，
 * 并进总额会让读数虚高（实测某账号因此从 155.67 变成 655.67）。
 */

/** 展示口径的额度单位（`credit` 是缺省：vendor 里 `credit` / `credits` / `积分` 并存）。 */
export type CreditUnit = "credit" | "token" | "percent" | "usd";

/** 一个额度包（资源包 / 配额窗口 / 模型桶）的展示读数。 */
export interface CreditPackageView {
  name: string;
  unit: CreditUnit;
  remaining: number;
  /** 本周期总额；`0` = 服务端未给面值（界面据此不画百分比）。 */
  total: number;
  used?: number;
  /** 该包当前是否仍可扣费。 */
  active: boolean;
  /** 失效时刻（原样字符串或 ISO）；缺失 = 未下发。 */
  expiresAt?: string;
  /** 周期重置时刻（`cycleEndTime` 一类）；与 {@link expiresAt} 不是一回事。 */
  resetAt?: string;
  /** 0..1；面值未知时不带 —— 不补 100%。 */
  progress?: number;
  /** 宿主拼好的读数：`155.67 / 200积分`、`94.54M / 100MToken`、`800积分`。 */
  label: string;
}

/** 一个账号的额度读数。字段全部可选：失败与「尚未查询」都不是错误值。 */
export interface CreditReading {
  /** 成功读到数据的时刻（毫秒）。刷新失败时保留上次成功的时间。 */
  at?: number;
  /** 最近一次刷新失败的原因（成功刷新后清除）。 */
  error?: string;
  /** 响应形状无法识别（界面回落到原始数据，便于排查）。 */
  unknown?: boolean;
  /** 有效包的余额合计（同单位时）。 */
  total?: number;
  /** 读数的单位；混单位时缺失。 */
  unit?: CreditUnit;
  /** 宿主拼好的读数：`155.67 / 200积分`、`94.54M / 100MToken`、`800积分`。 */
  label?: string;
  /** 0..1，有效包余额 / 有效包面值；面值未知或混单位时缺失。 */
  progress?: number;
  /** 已用合计（仅当服务端单独下发时；不拿 `total - remaining` 反推）。 */
  used?: number;
  packages?: CreditPackageView[];
  /** 包总数（含 0 余额与已失效，界面据此提示「N 个包」）。 */
  packagesCount?: number;
  /** 已失效包的余额合计（不计入 `total`）。 */
  expiredTotal?: number;
  /** 附加标签：套餐名 / 账号规格（Gemini `Pro` 一类）。 */
  tags?: string[];
  /** 一句说明：不限量、非积分账户、数据来自离线缓存…… */
  note?: string;
}

/** 失败时的统一说明（与 vendor 的「查不到」语义一致）。 */
export const CREDIT_FAILED_MESSAGE = "额度查询失败（凭据失效或响应异常）";

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 保留两位小数（多包相加的浮点尾数噪声在这里收口）。 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Unix 秒 → ISO；非正数/缺失返回 undefined（vendor 里 `0` 表示未下发）。 */

/** 毫秒时间戳 → ISO；非正数/缺失返回 undefined。 */
function isoFromMs(value: unknown): string | undefined {
  const ms = numberOf(value);
  if (ms === undefined || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * 单位归一。
 *
 * ⚠️ **缺省按积分**：vendor 里 `unit` 缺省、`credit`、`credits`、`积分` 混用
 * （实测同一账号内并存），分组键必须与展示名同源，否则同一份额度会被拆成两组。
 */
export function unitOf(raw: unknown): CreditUnit {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "token" || text === "tokens") return "token";
  if (text === "%" || text === "percent") return "percent";
  if (text === "usd" || text === "$") return "usd";
  return "credit";
}

/** 单位的展示名（与 `vendor/ofm/src/credits.ts` 的 `claimUnitLabel` 同口径）。 */
export function unitLabel(unit: CreditUnit): string {
  if (unit === "token") return "Token";
  if (unit === "percent") return "%";
  if (unit === "usd") return "USD";
  return "积分";
}

/**
 * 积分数值：整数不带小数位，有小数才保留两位，带千分位。
 *
 * ⚠️ **积分不压缩**：现实量级是 `123456.78`（IDE 顶部就是这个精度），
 * 压成 `123.46K` 会让用户无法与官方界面核对（同 vendor 的取舍）。
 */
export function formatCreditAmount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const rounded = round(value);
  return rounded.toLocaleString("zh-CN", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** token：`>= 1e6` → `94.54M`；`>= 1e3` → `945.39K`；其余取整。 */
export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const abs = Math.abs(value);
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (value / 1e3).toFixed(2) + "K";
  return String(Math.round(value));
}

/** 一个数值（不带单位）。 */
export function formatCreditValue(value: number, unit: CreditUnit): string {
  if (unit === "token") return formatTokenAmount(value);
  if (unit === "percent") return String(Math.round(value));
  return formatCreditAmount(value);
}

/**
 * 一个「数值 + 单位」的完整读数，如 `800积分` / `94.54MToken`。
 *
 * ⚠️ **数值与单位之间不留空格**：与 vendor 的用量徽标同形（`94.54MToken`），
 * 也让「155.67 / 200积分」读起来是一个整体。
 */
export function formatUnitAmount(value: number, unit: CreditUnit): string {
  return formatCreditValue(value, unit) + unitLabel(unit);
}

/** 把一组包收敛成读数（有效/失效分桶、单位分组、进度与文案）。 */
function summarize(
  packages: CreditPackageView[],
  options: { expiredTotal?: number; totalHint?: number; tags?: string[] } = {},
): CreditReading {
  const active = packages.filter((pkg) => pkg.active);
  const tags = (options.tags ?? []).filter((tag) => tag.length > 0);
  const base: CreditReading = {
    ...(tags.length > 0 ? { tags } : {}),
    ...(packages.length > 0
      ? { packages, packagesCount: packages.length }
      : {}),
  };
  // ⚠️ **全零占位包**（真实缺陷，2026-10-21 用户报障「Qoder 的两个卡片没
  // 渲染使用额度进度条」）：Qoder 的 `userQuota`（`套餐额度`）在免费档下发
  // `{ total: 0, used: 0, remaining: 0 }` —— 它既没有余额也没有用量，更没有
  // 面值，是一条**空占位**。它若参与「面值未知」判定与单位分组，就会把同一
  // 账号里真正有面值的 `资源包`（实测 `1,310 / 2,200`）的进度条一起撤掉，
  // 卡片只剩「1,310积分」。空占位不构成「一个我们不知道额度的包」：它对
  // remaining 与 capacity 都不贡献任何数字，故从合计里剔除（仍保留在
  // `packages` 明细里如实展示）。有余额（超过 0）或有已用量的包**仍然**会
  // 否决合计面值 —— 那些包的容量才是真的不知道，不能只对一部分包求和。
  const informative = (pkg: CreditPackageView) =>
    pkg.total > 0 || pkg.remaining > 0 || (pkg.used ?? 0) > 0;
  const counted = active.filter(informative);
  const units = [...new Set(counted.map((pkg) => pkg.unit))];
  // 混单位：逐单位给读数，**不给合计**（token 与积分不能相加）。
  if (units.length > 1) {
    // 顺序固定 token → 积分 → 其它：与 vendor `formatClaimGains` 同序，
    // 渲染不随对象/包顺序抖动。
    const order: CreditUnit[] = ["token", "credit", "percent", "usd"];
    const parts = units
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((unit) => {
        const sum = counted
          .filter((pkg) => pkg.unit === unit)
          .reduce((n, pkg) => n + pkg.remaining, 0);
        return formatUnitAmount(round(sum), unit);
      });
    return { ...base, label: parts.join(" · "), note: "多个单位，不做合计" };
  }
  const unit: CreditUnit = units[0] ?? packages[0]?.unit ?? "credit";
  const remaining = round(counted.reduce((n, pkg) => n + pkg.remaining, 0));
  const capacity = round(counted.reduce((n, pkg) => n + pkg.total, 0));
  // 合计面值只在**所有**参与合计的包都声明了面值时才成立：若只对一部分包
  // 求和，分母会小于真实剩余（进度还能超过 100%），等于报了一个自己并不知道
  // 的数。任一有余额/有用量的包面值未知 ⇒ 整个读数只显示剩余、不画进度条。
  const known = counted.length > 0 && counted.every((pkg) => pkg.total > 0);
  const hint = numberOf(options.totalHint);
  const expiredTotal = round(
    options.expiredTotal !== undefined
      ? Math.max(0, options.expiredTotal)
      : packages
          .filter((pkg) => !pkg.active)
          .reduce((n, pkg) => n + Math.max(0, pkg.remaining), 0),
  );
  // 没有逐包明细的渠道（只给一个总数）：只有 `total` 这一个读数，
  // 面值未知，故不画进度条。
  if (packages.length === 0) {
    const only = hint !== undefined && hint >= 0 ? round(hint) : undefined;
    return {
      ...base,
      ...(only !== undefined
        ? { total: only, unit, label: formatUnitAmount(only, unit) }
        : {}),
      ...(expiredTotal > 0 ? { expiredTotal } : {}),
    };
  }
  // 面值已知**且**分母为正才写 `剩余 / 总额`：全零包组成的账号没有可用的
  // 分母，此时只写剩余，绝不拼出「0 / 0积分」或除零的进度。
  const measured = known && capacity > 0;
  return {
    ...base,
    total: hint !== undefined && hint >= 0 ? round(hint) : remaining,
    unit,
    label: measured
      ? formatCreditValue(remaining, unit) +
        " / " +
        formatUnitAmount(capacity, unit)
      : formatUnitAmount(remaining, unit),
    ...(measured ? { progress: clamp01(remaining / capacity) } : {}),
    ...(expiredTotal > 0 ? { expiredTotal } : {}),
    ...(active.length === 0 ? { note: "额度包均已失效" } : {}),
  };
}

/** vendor 的通用 `CreditBalance`（buddy / qoder / trae / lobsterai / loomy / raccoon）。 */
function fromCreditBalance(value: unknown): CreditReading | undefined {
  const raw = recordOf(value);
  if (raw === undefined) return undefined;
  const list = raw.packages;
  if (!Array.isArray(list)) {
    // 只给一个总数、不给明细的响应 —— 有 `total` 就按单一读数处理。
    const total = numberOf(raw.total);
    if (total === undefined) return undefined;
    return summarize([], { totalHint: total });
  }
  const packages: CreditPackageView[] = [];
  for (const item of list) {
    const pkg = recordOf(item);
    if (pkg === undefined) continue;
    const remaining = Math.max(0, numberOf(pkg.remaining) ?? 0);
    const total = Math.max(0, numberOf(pkg.total) ?? 0);
    const used = numberOf(pkg.used);
    const expiresAt =
      textOf(pkg.expiredTime) ?? isoFromMs(pkg.deductionEndTime) ?? undefined;
    const resetAt = textOf(pkg.cycleEndTime);
    const unit = unitOf(pkg.unit);
    packages.push({
      name: textOf(pkg.name) ?? "额度包",
      unit,
      remaining,
      total,
      ...(used !== undefined ? { used } : {}),
      active: pkg.active !== false,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      // 面值未知（0）时不带进度：补 100% 等于宣称一个不知道的满额。
      ...(total > 0 ? { progress: clamp01(remaining / total) } : {}),
      // 每个包自带读数，展开明细时不必再回头算（口径与汇总一致）。
      label:
        total > 0
          ? formatCreditValue(remaining, unit) +
            " / " +
            formatUnitAmount(total, unit)
          : formatUnitAmount(remaining, unit),
    });
  }
  return summarize(packages, {
    ...(numberOf(raw.expiredTotal) !== undefined
      ? { expiredTotal: numberOf(raw.expiredTotal) }
      : {}),
    ...(numberOf(raw.total) !== undefined
      ? { totalHint: numberOf(raw.total) }
      : {}),
  });
}

/** Gemini 的带原因包装：`{ balance, error?, tier?, rawBalance? }`。 */
function fromWrappedBalance(value: unknown): CreditReading | undefined {
  const raw = recordOf(value);
  if (raw === undefined || !("balance" in raw)) return undefined;
  const error = textOf(raw.error);
  const tier = recordOf(raw.tier);
  const tags =
    tier === undefined
      ? []
      : [textOf(tier.label) ?? textOf(tier.name)].filter(
          (tag): tag is string => tag !== undefined,
        );
  const inner =
    raw.balance === null ? undefined : fromCreditBalance(raw.balance);
  if (inner === undefined) {
    return {
      error: error ?? CREDIT_FAILED_MESSAGE,
      ...(tags.length > 0 ? { tags } : {}),
    };
  }
  const title = tier === undefined ? undefined : textOf(tier.title);
  return {
    ...inner,
    ...(error !== undefined ? { error } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(title !== undefined ? { note: title } : {}),
  };
}

/** CodeArts：只有积分计费账户才带 `credit`；Token 计费账户要如实说明。 */
function fromCodeArts(value: unknown): CreditReading | undefined {
  const raw = recordOf(value);
  if (raw === undefined || typeof raw.isCreditPackage !== "boolean")
    return undefined;
  const packageName = textOf(raw.packageName);
  const tags = packageName === undefined ? [] : [packageName];
  if (raw.isCreditPackage === false) {
    return {
      ...(tags.length > 0 ? { tags } : {}),
      note:
        raw.isTokenPackage === true
          ? "Token 计费账户，没有积分口径"
          : "非积分计费账户，没有积分口径",
    };
  }
  const credit = fromCreditBalance(raw.credit);
  if (credit === undefined)
    return {
      ...(tags.length > 0 ? { tags } : {}),
      note: "积分账户，但本次响应没有额度明细",
    };
  return { ...credit, ...(tags.length > 0 ? { tags } : {}) };
}

/** 按形状识别并归一；识别不了返回 undefined（由调用方标 `unknown`）。 */
function readValue(value: unknown): CreditReading | undefined {
  const raw = recordOf(value);
  if (raw === undefined) return undefined;
  // 顺序即优先级：先认**独有**字段（`isCreditPackage` /
  // `balance` 包装），最后才落到通用 `CreditBalance`。
  if (typeof raw.isCreditPackage === "boolean") return fromCodeArts(raw);
  if ("balance" in raw) return fromWrappedBalance(raw);
  if (Array.isArray(raw.packages) || numberOf(raw.total) !== undefined)
    return fromCreditBalance(raw);
  return undefined;
}

/**
 * 一份**已保存的**额度快照 → 展示读数。
 *
 * 快照形状由本插件自己写：`{ at, value?, error?, errorAt? }`（见
 * `src/index.ts` 的 `credits.refresh`）。刷新失败时**保留上次成功的读数**，
 * 同时带上失败原因 —— 界面既能显示「上次读数」，也能显示「这次没刷上」。
 *
 * @param snapshot - `balance:<accountId>` 的 KV 值；缺失表示从未查询。
 * @returns 读数；从未查询过时返回 `undefined`（界面显示「未查询」）。
 */
export function creditReading(snapshot: unknown): CreditReading | undefined {
  const snap = recordOf(snapshot);
  if (snap === undefined) return undefined;
  const at = numberOf(snap.at);
  const error = textOf(snap.error);
  const value = snap.value;
  if (value === undefined) {
    return {
      ...(at !== undefined ? { at } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
  // `null` 是各 vendor 的「查不到」：绝不当成 0。
  if (value === null) {
    return {
      ...(at !== undefined ? { at } : {}),
      error: error ?? CREDIT_FAILED_MESSAGE,
    };
  }
  const reading = readValue(value);
  if (reading === undefined) {
    return {
      ...(at !== undefined ? { at } : {}),
      unknown: true,
      error: error ?? "无法识别的额度响应",
    };
  }
  return {
    ...reading,
    ...(at !== undefined ? { at } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
