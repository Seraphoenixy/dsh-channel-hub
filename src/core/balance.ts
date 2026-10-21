import { creditReading, CREDIT_FAILED_MESSAGE } from "./credits.ts";
import { redact, type Account, type Logger } from "./types.ts";
import type { Store } from "../storage/client.ts";

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
  private async fetch(a: Account) {
    if (!this.current(a)) throw Error("账号已变更，请重新刷新");
    const key = "balance:" + a.id;
    try {
      const value = await this.options.query(a);
      const reading = creditReading({ value });
      if (value === null || value === undefined || reading?.error)
        throw Error(reading?.error ?? CREDIT_FAILED_MESSAGE);
      if (!this.current(a)) throw Error("账号已变更，请重新刷新");
      const snapshot = { at: this.now(), value };
      await this.options.store.call("set", key, snapshot);
      this.failures.delete(a.id);
      return { value, credits: creditReading(snapshot) };
    } catch (error) {
      if (this.current(a)) {
        const previous = await this.options.store.call("get", key);
        const count = (this.failures.get(a.id) ?? 0) + 1;
        this.failures.set(a.id, count);
        const now = this.now();
        await this.options.store.call("set", key, {
          ...(previous && typeof previous === "object" ? previous : {}),
          error: redact(error), errorAt: now,
          retryAt: now + Math.min(1800000, 30000 * 2 ** Math.min(count - 1, 6)),
        });
      }
      throw error;
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
