import { redact } from "./types.ts";
import type { Account } from "./types.ts";
export const RENEWAL_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
export class RenewalService {
  private jobs = new Map<string, Promise<void>>();
  private failures = new Map<
    string,
    { next: number; count: number; error: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private renewedUntil = new Map<string, number>();
  constructor(
    private accounts: () => Promise<Account[]>,
    private refresh: (a: Account) => Promise<void>,
  ) {}
  renew(a: Account, force = true) {
    if (this.stopped) return Promise.reject(Error("自动续期服务已停止"));
    const old = this.jobs.get(a.id);
    if (old) return old;
    if (!force && Math.max(this.renewedUntil.get(a.id) ?? 0, this.failures.get(a.id)?.next ?? 0) > Date.now())
      return Promise.resolve();
    const task = this.refresh(a)
      .then(async () => {
        this.failures.delete(a.id);
        const current = (await this.accounts()).find((entry) => entry.id === a.id);
        const now = Date.now();
        // A one-hour token remains inside the three-day window even after
        // renewal. Wait for half its new lifetime instead of rotating it on
        // every scan; credentials with a longer lifetime use the usual gate.
        if (current?.expiresAt !== undefined && current.expiresAt > now && current.expiresAt <= now + RENEWAL_LEAD_MS)
          this.renewedUntil.set(a.id, now + Math.max(30000, Math.min(86400000, (current.expiresAt - now) / 2)));
        else this.renewedUntil.delete(a.id);
      })
      .catch((e) => {
        const count = (this.failures.get(a.id)?.count ?? 0) + 1;
        this.failures.set(a.id, {
          count,
          next:
            Date.now() + Math.min(1800000, 30000 * 2 ** Math.min(count - 1, 6)),
          error: redact(e),
        });
        throw e;
      })
      .finally(() => this.jobs.delete(a.id));
    this.jobs.set(a.id, task);
    return task;
  }
  async tick(now = Date.now()) {
    const accounts = await this.accounts();
    if (this.stopped) return;
    await Promise.allSettled(
      accounts
        .filter(
          (a) =>
            a.refreshable &&
            a.expiresAt !== undefined &&
            a.expiresAt <= now + RENEWAL_LEAD_MS &&
            (this.renewedUntil.get(a.id) ?? 0) <= now &&
            (this.failures.get(a.id)?.next ?? 0) <= now,
        )
        .map((a) => this.renew(a, false)),
    );
  }
  status(id: string) {
    return { refreshing: this.jobs.has(id), ...this.failures.get(id) };
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 60 * 60 * 1000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.jobs.values()]);
  }
}
