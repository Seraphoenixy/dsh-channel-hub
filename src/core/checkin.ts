import { dayOf, redact, type Account, type Logger } from "./types.ts";
import { formatUnitAmount } from "./credits.ts";
import type { Store } from "../storage/client.ts";

export interface CheckinStatus {
  day: string;
  state: "pending" | "running" | "done" | "waiting" | "inactive" | "manual" | "failed" | "unsupported";
  label: string;
  message?: string;
  at?: number;
  nextAt?: number;
  failures?: number;
  credentialRef?: string;
  coversToday?: boolean;
}

export class CheckinService {
  private jobs = new Map<string, Promise<CheckinStatus>>();
  private timer?: ReturnType<typeof setInterval>;
  private tickJob?: Promise<void>;
  private stopped = false;
  constructor(private options: {
    accounts: () => Promise<Account[]>;
    getAccount: (id: string) => Account | undefined;
    mode: (a: Account) => "auto" | "manual" | "unsupported";
    claim: (a: Account) => Promise<any>;
    afterClaim: (a: Account) => Promise<unknown>;
    store: Store;
    logger: Logger;
    now?: () => number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private current(a: Account) {
    const latest = this.options.getAccount(a.id);
    return latest?.provider === a.provider && latest.credentialRef === a.credentialRef;
  }
  async status(a: Account): Promise<CheckinStatus> {
    const day = dayOf(this.now());
    const mode = this.options.mode(a);
    if (mode === "unsupported") return { day, state: "unsupported", label: "不支持自动签到" };
    if (this.jobs.has(a.id)) return { day, state: "running", label: "正在签到" };
    const saved = await this.options.store.call("get", "checkin:" + a.id);
    if (saved?.day === day && saved.credentialRef === a.credentialRef) return saved;
    if (mode === "manual") return { day, state: "manual", label: "需手动签到", message: "此渠道签到需要验证码，请手动处理" };
    return { day, state: "pending", label: "等待自动签到" };
  }
  run(a: Account, manual = false) {
    const old = this.jobs.get(a.id);
    if (old) return old;
    if (this.stopped) return Promise.reject(Error("自动签到服务已停止"));
    const job = this.execute(a, manual).finally(() => this.jobs.delete(a.id));
    this.jobs.set(a.id, job);
    return job;
  }
  private async execute(a: Account, manual: boolean): Promise<CheckinStatus> {
    const now = this.now(), day = dayOf(now);
    const mode = this.options.mode(a);
    if (mode === "unsupported" || (mode === "manual" && !manual)) {
      return { day, state: mode === "unsupported" ? "unsupported" : "manual", label: mode === "unsupported" ? "不支持自动签到" : "需手动签到" };
    }
    const previous = await this.options.store.call("get", "checkin:" + a.id);
    if (!manual && previous?.day === day && previous.credentialRef === a.credentialRef && previous.nextAt > now &&
        !(previous.state === "inactive" && previous.coversToday === undefined)) return previous;
    if (!this.current(a)) throw Error("签到账号已变更");
    const nextDay = Date.parse(day + "T00:00:00+08:00") + 86400000;
    const status: CheckinStatus = { day, state: "failed", label: "签到失败", at: now, credentialRef: a.credentialRef };
    let claimed = false;
    try {
      const outcome = await this.options.claim(a);
      status.coversToday = outcome?.coversToday !== false;
      if (outcome?.kind === "failed") throw Error(outcome.message || "签到失败");
      if (outcome?.kind === "claimed" || outcome?.kind === "already-claimed") {
        claimed = outcome.kind === "claimed";
        if (outcome.coversToday === false) {
          status.state = "waiting"; status.label = "等待本轮活动刷新";
          status.message = "上游结果不覆盖今日活动，将自动再次检查";
          status.nextAt = now + 3600000;
        } else {
          status.state = "done"; status.label = "今日已签到"; status.nextAt = nextDay;
          if (claimed && typeof outcome.credit === "number" && Number.isFinite(outcome.credit))
            status.message = "本次获得 " + formatUnitAmount(outcome.credit, outcome.unit === "token" ? "token" : "credit");
          if (typeof outcome.delayedMessage === "string" && outcome.delayedMessage)
            status.message = [status.message, redact(outcome.delayedMessage)].filter(Boolean).join("；");
        }
      } else if (outcome?.kind === "inactive") {
        status.state = outcome.actionRequired ? "manual" : outcome.coversToday === false ? "waiting" : "inactive";
        status.label = outcome.actionRequired ? "需要手动处理" : outcome.coversToday === false ? "等待本轮活动刷新" : "暂不可签到";
        status.message = redact(outcome.message || "暂不可签到");
        status.nextAt = outcome.actionRequired ? nextDay : now + 3600000;
      } else throw Error("签到返回了未知结果");
    } catch (error) {
      const failures = previous?.day === day ? (previous.failures ?? 0) + 1 : 1;
      status.failures = failures;
      status.message = redact(error);
      status.nextAt = now + Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4));
    }
    if (!this.current(a)) throw Error("签到账号已变更");
    await this.options.store.call("set", "checkin:" + a.id, status);
    if (claimed) {
      try { await this.options.afterClaim(a); }
      catch (error) { this.options.logger.warn("签到后更新额度失败：" + redact(error)); }
    }
    return status;
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.tickJob) return this.tickJob;
    const job = (async () => {
      for (const a of await this.options.accounts()) {
        if (this.stopped) break;
        if (this.options.mode(a) !== "auto") continue;
        try { await this.run(a); }
        catch (error) { this.options.logger.warn("自动签到异常：" + redact(error)); }
      }
    })().finally(() => { this.tickJob = undefined; });
    this.tickJob = job;
    return job;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(e => this.options.logger.warn(redact(e))); }, 300000);
    this.timer.unref();
    void this.tick().catch(e => this.options.logger.warn(redact(e)));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.tickJob, ...this.jobs.values()]);
  }
}
