export type Outcome =
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}
export interface Attempt {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  accountId: string;
  accountName?: string;
  started: number;
  ended?: number;
  first?: number;
  firstText?: number;
  outcome: Outcome;
  usage?: Usage;
  error?: string;
}
export interface RequestRow {
  id: string;
  provider: string;
  model: string;
  started: number;
  ended?: number;
  outcome: Outcome;
  error?: string;
  /** 会话 id（DSH 的 `sessionId`；缺省表示该调用不属于任何会话）。 */
  sessionId?: string;
  /**
   * **轮次**标识：同一条用户消息引发的多次模型调用共享一个 `turnId`。
   *
   * DSH 不向适配器下发 turn/step，故由本插件按「最后一条消息是不是
   * 纯用户消息（不含 tool-result）」推断：是则开启新一轮，否则沿用该会话
   * 当前轮的 id。没有 `sessionId` 时，每个请求自成一轮（等同于步）。
   */
  turnId?: string;
  /** 本次调用是否开启了一轮（用于诊断推断是否正确）。 */
  startsTurn?: boolean;
}
export interface Filter {
  from?: number;
  to?: number;
  provider?: string;
  accountId?: string;
  model?: string;
  outcome?: Outcome;
  page?: number;
  limit?: number;
}
export interface Model {
  id: string;
  name: string;
  contextWindow?: number;
  priceFactor?: number;
  [key: string]: unknown;
}
export interface Account {
  id: string;
  provider: string;
  nickname: string;
  credentialRef: string;
  enabled: boolean;
  expiresAt?: number;
  refreshable?: boolean;
  [key: string]: unknown;
}
export interface Logger {
  warn(message: string): void;
  info?(message: string): void;
}

/**
 * 把一次失败的 HTTP 响应整理成「带原因」的目录错误文本。
 *
 * ## 为什么需要它（真实缺陷，2026-10-23）
 *
 * 目录刷新过去只写 `"目录 HTTP " + status`，把响应体整个丢掉。于是用户看到
 * 「目录 HTTP 403」，而实际原因可能是**账号被禁用**（`{"code":40302,
 * "message":"账号已被禁用"}`）、额度耗尽、或该模型无权限 —— 403 同时覆盖这
 * 四种语义，只看状态码无法归因，排查只能去翻数据库按时间线反推。
 *
 * 同一时期额度查询已经修成透传上游 `code` / `msg`，目录这条链路是同一个
 * 毛病，故统一到同一口径。
 *
 * @param label - 渠道前缀，如 `"目录"` / `"Gemini 目录"`。
 * @param status - HTTP 状态码。
 * @param body - 响应体原文（非 JSON 也照收，只截片段）。
 * @returns 如 `目录 HTTP 403：code 40302：账号已被禁用`。
 */
export function describeHttpFailure(
  label: string,
  status: number,
  body: string,
): string {
  const head = `${label} HTTP ${status}`;
  const text = body.trim();
  if (text.length === 0) return head;
  let detail = "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      // 各家后端把原因放在不同字段；漏认一个就会把已说清的原因降级成状态码。
      const code = record.code ?? record.error_code ?? record.status;
      const message =
        record.msg ??
        record.message ??
        record.error_msg ??
        record.error ??
        record.error_description ??
        record.detail;
      const parts: string[] = [];
      if (code !== undefined && code !== null && String(code).length > 0)
        parts.push(`code ${String(code)}`);
      if (typeof message === "string" && message.trim().length > 0)
        parts.push(message.trim());
      detail = parts.join("：");
    }
  } catch {
    // 非 JSON（网关 HTML 页一类）：截一段原文，也比只有状态码有用。
    detail = text.slice(0, 200).replace(/\s+/g, " ");
  }
  if (detail.length === 0) {
    // 解析成功但没有任何可读字段：退回一段原始片段，别假装没有响应体。
    detail = text.slice(0, 200).replace(/\s+/g, " ");
  }
  return detail.length > 0 ? `${head}：${detail}` : head;
}
/**
 * 把任意抛出物整理成一句可读、已脱敏的短文本。
 *
 * ## 为什么要处理非 `Error`
 *
 * **真实缺陷（2026-10-21，运行日志自查）**：多处 `outcome:"cancelled"` 的
 * `error` 是字面量 `"[object Object]"`。根因是宿主把中断归类成
 * `{type:'finish', reason:{kind:'aborted', failure:{message, code}}}` 这样的
 * **普通对象**，而本函数旧实现只认 `error.message` —— 一旦上游把对象本身
 * 传进来（而不是它的 `message`），`String(obj)` 就得到 `[object Object]`。
 * 用户因此看不懂发生了什么，排查也无从下手。
 *
 * 取值顺序：`Error.message` → 对象自带的 `message` / `msg` / `error` /
 * `reason` → JSON（截断）→ `String()`。**任何一步都不抛**（宿主可能传入
 * 带陷阱的代理对象）。
 */
export function redact(error: unknown): string {
  const text = describeThrown(error)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .trim();
  // 全部取值方式都失败时给一句可行动的话，而不是空串或 `[object Object]`。
  return (text.length > 0 ? text : "未知错误（抛出物不可读）").slice(0, 1600);
}

/** {@link redact} 的取值链；只负责"读出人话"，不做脱敏。 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    // `AbortError` 的 message 是 `This operation was aborted` —— 单独点明
    // 语义，否则用户会以为这是上游故障（它其实是"这次请求被取消了"）。
    const message = error.message;
    if (error.name === "AbortError")
      return message.length > 0 ? "请求已取消：" + message : "请求已取消";
    if (error.name === "TimeoutError")
      return message.length > 0 ? "请求超时：" + message : "请求超时";
    return message;
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean")
    return String(error);
  if (error === null || error === undefined) return "";
  try {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "msg", "error", "detail"] as const) {
      const value = record[key];
      // 只认字符串叶子：嵌套对象交给下面的递归/ JSON 分支，
      // 逐层展开会把一句原因拼成一长串。
      if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
    }
    // `reason` / `cause` 常包装一个真正的 Error（如 `{reason: DOMException}`）：
    // 递归一层取它的 message，否则会落到 JSON 变成一个 `{}`。
    for (const key of ["reason", "cause", "failure"] as const) {
      const value = record[key];
      if (value instanceof Error) return describeThrown(value);
      if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
      if (typeof value === "object" && value !== null) {
        const nested = describeThrown(value);
        if (nested.length > 0) return nested;
      }
    }
    // 折叠成一句：换行会让日志表按行错位。
    const json = JSON.stringify(error)?.replace(/\s+/g, " ").slice(0, 400) ?? "";
    if (json.length > 0 && json !== "{}") return json;
  } catch {
    // 循环引用 / 带陷阱的代理：JSON 序列化失败。
  }
  // ⚠️ 最后才试 `String()`，且**必须滤掉 `[object Object]`**：那正是本次要修
  // 的症状（循环引用对象走 String() 就得到它）。滤掉后 `redact` 会给出
  // 「未知错误（抛出物不可读）」，比一个无法排查的字面量有意义。
  try {
    const text = String(error);
    return text === "[object Object]" ? "" : text;
  } catch {
    return "";
  }
}
export function dayOf(ts: number): string {
  return new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
}
export function normalizeUsage(raw: Record<string, unknown>): Usage {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  // Input here is the DSH normalized non-cache input count, not OpenAI prompt_tokens.
  return {
    input: n(raw.inputTokens) ?? 0,
    output: n(raw.outputTokens) ?? 0,
    cacheRead: n(raw.cacheReadTokens),
    cacheWrite: n(raw.cacheWriteTokens),
    reasoning: n(raw.reasoningTokens),
    total: n(raw.totalTokens),
  };
}

/** Only explicit absolute timestamps or JWT exp; never invent a lifetime from expires_in. */
export function credentialExpiry(
  c: Record<string, any> | undefined,
): number | undefined {
  const raw =
    c?.expire_time ?? c?.expires_at ?? c?.expiresAt ?? c?.expiry ?? c?.expires;
  let value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : typeof raw === "string"
          ? Date.parse(raw)
          : undefined;
  if (value !== undefined && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value;
  const token = c?.access_token;
  if (typeof token === "string" && token.split(".").length === 3) {
    try {
      const exp = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      ).exp;
      if (typeof exp === "number" && Number.isFinite(exp) && exp > 0)
        return exp * 1000;
    } catch {}
  }
  return undefined;
}
