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
export function redact(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 1600);
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
