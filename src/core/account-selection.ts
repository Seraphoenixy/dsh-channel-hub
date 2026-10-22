import type { Store } from "../storage/client.ts";

interface SelectableAccount {
  id: string;
  provider: string;
  enabled: boolean;
}

/** Persist an explicit channel preference; a missing/deactivated target never means auto. */
export class AccountSelection {
  private values = new Map<string, string | null>();
  private loads = new Map<string, Promise<string | null>>();
  private writes = new Map<string, Promise<unknown>>();
  constructor(
    private store: Store,
    private findAccount: (id: string) => SelectableAccount | undefined,
  ) {}

  get(provider: string): Promise<string | null> {
    if (this.values.has(provider))
      return Promise.resolve(this.values.get(provider)!);
    const existing = this.loads.get(provider);
    if (existing) return existing;
    const task = this.store
      .call("get", "account-selection:" + provider)
      .then((saved) => {
        if (
          saved !== undefined &&
          saved !== null &&
          (typeof saved !== "string" || !saved)
        )
          throw Error("渠道账号选择设置损坏，请重新选择账号");
        const value = saved ?? null;
        this.values.set(provider, value);
        return value;
      })
      .finally(() => this.loads.delete(provider));
    this.loads.set(provider, task);
    return task;
  }

  set(provider: string, accountId: string | null): Promise<void> {
    const task = (this.writes.get(provider) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.get(provider);
        if (accountId !== null) this.requireAccount(provider, accountId);
        await this.store.call(
          "set",
          "account-selection:" + provider,
          accountId,
        );
        this.values.set(provider, accountId);
      });
    this.writes.set(provider, task);
    void task
      .finally(() => {
        if (this.writes.get(provider) === task) this.writes.delete(provider);
      })
      .catch(() => {});
    return task;
  }

  requireAccount(provider: string, accountId: string): SelectableAccount {
    const account = this.findAccount(accountId);
    if (!account || account.provider !== provider)
      throw Error("指定账号不存在或不属于该渠道，请在渠道中心重新选择");
    if (!account.enabled)
      throw Error("指定账号已停用，请启用该账号或在渠道中心重新选择");
    return account;
  }
}
