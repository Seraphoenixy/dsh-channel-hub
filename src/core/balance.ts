import { creditReading, CREDIT_FAILED_MESSAGE } from "./credits.ts";
import { redact, type Account, type Logger } from "./types.ts";
import type { Store } from "../storage/client.ts";

/**
 * 拆开驱动返回值里的「读数」与「失败原因」。
 *
 * 驱动可能给出三种形状，全部都要认（历史快照里三种都真实存在）：
 *
 * | 形状 | 来源 |
 * |---|---|
 * | `{ balance: <读数>, error?: undefined }` | 各渠道的 `…Detailed`（当前实现） |
 * | `{ balance: null, error: string }` | 同上，失败分支 |
 * | 直接是读数或 `null` | 旧驱动的 `fetch*CreditBalance`（保留兼容） |
 *
 * ⚠️ 不能只看 `'balance' in raw` 就当作包装：`CodeArtsAccountInfo` 与
 * `CreditBalance` 都没有 `balance` 字段，但 ACP/其它包装可能将来有 ——
 * 因此只在 `balance` 为 `null`、或带 `error` 时才算「包装」。
 * 真正的要求是：**成功读数原样返回**，别把余额对象当成包装拆开。
 */
function unwrapBalance(raw: unknown): { value: unknown; reason?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { value: raw };
  const record = raw as Record<string, unknown>;
  const text = typeof record.error === "string" && record.error.trim().length > 0
    ? record.error.trim()
    : undefined;
  // 判据：带 `error`，或 `balance` 存在但为 null —— 这两种只可能是包装。
  // ⚠️ `{ balance: <读数> }`（成功且无 error）也必须算包装，否则余额对象会被
  // 原样返回、`creditReading` 读不到 `total`（回归测试锁死）。
  if (text !== undefined)
    return { value: record.balance ?? null, reason: text };
  if ("balance" in record && record.balance !== undefined)
    return { value: record.balance };
  return { value: raw };
}

export class BalanceService {
  private jobs = new Map<string, Promise<any>>();
  private failures = new Map<string, number>();
  private tickJob?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private options: {
    accounts: () => Promise<Account[]>;
    getAccount: (id: string) => Account | undefined;
    supports: (a: Account) => boolean;
    query: (a: Account) => Promise<unknown>;
    store: Store;
    logger: Logger;
    now?: () => number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private current(a: Account) {
    const latest = this.options.getAccount(a.id);
    return latest?.provider === a.provider && latest.credentialRef === a.credentialRef;
  }
  refresh(a: Account) {
    const old = this.jobs.get(a.id);
    if (old) return old;
    if (this.stopped) return Promise.reject(Error("额度刷新服务已停止"));
    const job = this.fetch(a).finally(() => this.jobs.delete(a.id));
    this.jobs.set(a.id, job);
    return job;
  }
  /**
   * 取一个账号的额度。
   *
   * 驱动（`drivers/ofm.js`）返回两种形状之一：
   *
   * - `{ balance: CreditBalance, error?: undefined }` —— 成功；
   * - `{ balance: null, error: string }` —— 失败，`error` 是**上游给的**原因
   *   （如 `额度查询失败（HTTP 403）：code 40302：账号已被禁用`）。
   *
   * 旧实现只认 `null` 并把它统一成一句通用文案，于是「账号被禁用」会被
   * 显示成「凭据失效」—— 把用户引向重新登录这个无效动作（真实故障）。
   * 现在优先使用驱动给出的原因，通用文案只作为最后兜底。
   */
  private async fetch(a: Account) {
    if (!this.current(a)) throw Error("账号已变更，请重新刷新");
    const key = "balance:" + a.id;
    try {
      const raw = await this.options.query(a);
      const { value, reason } = unwrapBalance(raw);
      const reading = creditReading({ value });
      if (value === null || value === undefined || reading?.error)
        // 顺序：驱动给的明确原因 → 归一化层的原因 → 通用兜底。
        throw Error(reason ?? reading?.error ?? CREDIT_FAILED_MESSAGE);
      if (!this.current(a)) throw Error("账号已变更，请重新刷新");
      const snapshot = { at: this.now(), value };
      await this.options.store.call("set", key, snapshot);
      this.failures.delete(a.id);
      return { value, credits: creditReading(snapshot) };
    } catch (error) {
      // 失败时**必须**把原因落库：界面读的是 `balance:<id>` 里的 `error`，
      // 只 throw 不写库的话，用户重新打开面板看到的仍是旧读数。
      const reason = redact(error);
      if (this.current(a)) {
        const previous = await this.options.store.call("get", key);
        const count = (this.failures.get(a.id) ?? 0) + 1;
        this.failures.set(a.id, count);
        const now = this.now();
        await this.options.store.call("set", key, {
          ...(previous && typeof previous === "object" ? previous : {}),
          error: reason, errorAt: now,
          retryAt: now + Math.min(1800000, 30000 * 2 ** Math.min(count - 1, 6)),
        });
      }
      throw Error(reason);
    }
  }
  tick(now = this.now()) {
    if (this.stopped) return Promise.resolve();
    if (this.tickJob) return this.tickJob;
    const job = (async () => {
      // Sequential across accounts to avoid a startup burst against upstreams.
      for (const a of await this.options.accounts()) {
        if (this.stopped) break;
        if (!this.options.supports(a)) continue;
        const snapshot = await this.options.store.call("get", "balance:" + a.id);
        if (this.stopped) break;
        if (snapshot?.error) {
          if ((snapshot.retryAt ?? (snapshot.errorAt ?? 0) + 30000) > now) continue;
        } else if (typeof snapshot?.at === "number" && snapshot.at + 300000 > now) continue;
        try { await this.refresh(a); }
        catch (error) { this.options.logger.warn("自动查询额度失败：" + redact(error)); }
      }
    })().finally(() => { this.tickJob = undefined; });
    this.tickJob = job;
    return job;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch((e) => this.options.logger.warn(redact(e))); }, 30000);
    this.timer.unref();
    void this.tick().catch((e) => this.options.logger.warn(redact(e)));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.tickJob, ...this.jobs.values()]);
  }
}
