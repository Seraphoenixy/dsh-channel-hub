import type { Attempt, RequestRow } from "./types.ts";
export interface Metrics {
  requests: number;
  success: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  attempts: number;
  attemptFailures: number;
  reported: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheInput: number;
  cacheHitTokens: number;
  cacheSamples: number;
  cacheWriteSamples: number;
  reasoningSamples: number;
  speedSum: number;
  speedSamples: number;
  throughputSum: number;
  throughputSamples: number;
  firstSum: number;
  firstSamples: number;
}
export const empty = (): Metrics => ({
  requests: 0,
  success: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  attempts: 0,
  attemptFailures: 0,
  reported: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cacheInput: 0,
  cacheHitTokens: 0,
  cacheSamples: 0,
  cacheWriteSamples: 0,
  reasoningSamples: 0,
  speedSum: 0,
  speedSamples: 0,
  throughputSum: 0,
  throughputSamples: 0,
  firstSum: 0,
  firstSamples: 0,
});
export function add(a: Metrics, b: Metrics): Metrics {
  const out = empty();
  for (const k of Object.keys(out) as (keyof Metrics)[])
    out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}
export function measure(
  req: RequestRow,
  rows: Attempt[],
  countRequest = true,
): Metrics {
  const m = empty();
  if (countRequest) {
    m.requests = 1;
    if (req.outcome !== "running") m[req.outcome]++;
  }
  for (const a of rows) {
    m.attempts++;
    if (a.outcome === "failed") m.attemptFailures++;
    if (!a.usage) continue;
    m.reported++;
    const u = a.usage;
    m.input += u.input;
    m.output += u.output;
    m.cacheRead += u.cacheRead ?? 0;
    m.cacheWrite += u.cacheWrite ?? 0;
    m.reasoning += u.reasoning ?? 0;
    if (u.reasoning !== undefined) m.reasoningSamples++;
    if (u.cacheWrite !== undefined) m.cacheWriteSamples++;
    if (u.cacheRead !== undefined) {
      m.cacheSamples++;
      m.cacheHitTokens += u.cacheRead;
      m.cacheInput += u.input + u.cacheRead + (u.cacheWrite ?? 0);
    }
  }
  const first = rows.find((a) => a.first !== undefined);
  if (first) {
    m.firstSum = first.first! - req.started;
    m.firstSamples = 1;
  }
  // A speed sample describes the final serving attempt; failed attempts still contribute usage.
  //
  // ⚠️ **收尾时最后一条 attempt 可能还没落定**：适配器常常在 HTTP body 读到
  // EOF 之前就结束迭代，`ended` / `outcome` 由 fetcher 稍后补写。此时若直接读
  // `final.ended`，`ended > first` 恒为假、速度与吞吐会被**系统性丢成 0**
  // （线上 945 条请求 0 个样本的真实原因）。故用请求自身的结束时刻与结果兜底。
  const final = rows.at(-1);
  const ended = final?.ended ?? req.ended;
  const outcome = final?.outcome === "running" ? req.outcome : final?.outcome;
  if (
    outcome === "success" &&
    final?.usage &&
    final.first !== undefined &&
    ended !== undefined &&
    ended > final.first
  ) {
    m.speedSum = final.usage.output / ((ended - final.first) / 1000);
    m.speedSamples = 1;
  }
  // 整块吞吐：端到端耗时（含首字等待）为分母，成功且有 usage 即可得。
  //
  // ⚠️ 与 `speedSum` **分开统计**，绝不混进同一个平均：两者分母不同
  // （流式窗口 vs 端到端）。拿总时长当流式速度会低估，拿首字窗口当整块吞吐
  // 会高估 —— 混在一起的平均值两个含义都不是。
  if (
    outcome === "success" &&
    final?.usage &&
    req.ended !== undefined &&
    req.ended > req.started
  ) {
    m.throughputSum =
      final.usage.output / ((req.ended - req.started) / 1000);
    m.throughputSamples = 1;
  }
  return m;
}
export function present(m: Metrics) {
  return {
    ...m,
    totalTokens: m.input + m.cacheRead + m.cacheWrite + m.output,
    successRate:
      m.success + m.failed ? m.success / (m.success + m.failed) : null,
    avgTps: m.speedSamples ? m.speedSum / m.speedSamples : null,
    avgThroughput: m.throughputSamples
      ? m.throughputSum / m.throughputSamples
      : null,
    avgTtftMs: m.firstSamples ? m.firstSum / m.firstSamples : null,
    cacheHitRate: m.cacheInput ? m.cacheHitTokens / m.cacheInput : null,
    cacheCoverage: m.reported ? m.cacheSamples / m.reported : null,
  };
}
