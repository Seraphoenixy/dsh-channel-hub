import { redact } from "./types.ts";
import type { Model } from "./types.ts";
import type { Store } from "../storage/client.ts";
export interface Snapshot {
  models: Model[];
  updated: number;
  stale: boolean;
  error?: string;
}
export class CatalogService {
  private inflight = new Map<string, Promise<Snapshot>>();
  private cache = new Map<string, Snapshot>();
  constructor(private store: Store) {}
  async load(key: string) {
    if (!this.cache.has(key)) {
      const saved = await this.store.call<Snapshot | undefined>(
        "get",
        "catalog:" + key,
      );
      if (saved) this.cache.set(key, { ...saved, stale: true });
    }
    return this.cache.get(key) ?? { models: [], updated: 0, stale: true };
  }
  /**
   * 丢掉一个键的内存缓存（删号时调用）。
   *
   * 不丢的后果：同一账号 id 重新登录后 `hydrate()` 会先命中这份旧缓存，把上一个
   * 账号的模型目录带回来 —— 此时磁盘上的行已经被 `purgeAccountSnapshots` 清掉了。
   */
  forget(key: string) {
    this.cache.delete(key);
  }
  refresh(key: string, fetcher: () => Promise<Model[]>): Promise<Snapshot> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const previous = await this.load(key);
      try {
        const models = await fetcher();
        if (!Array.isArray(models)) throw Error("Invalid model directory");
        const ids = new Set<string>();
        for (const m of models) {
          if (!m.id || ids.has(m.id))
            throw Error("Invalid or duplicate model id");
          ids.add(m.id);
          if (
            m.priceFactor !== undefined &&
            (!Number.isFinite(m.priceFactor) || m.priceFactor < 0)
          )
            delete m.priceFactor;
        }
        const next = { models, updated: Date.now(), stale: false };
        await this.store.call("set", "catalog:" + key, next);
        this.cache.set(key, next);
        return next;
      } catch (e) {
        const next = { ...previous, stale: true, error: redact(e) };
        this.cache.set(key, next);
        return next;
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
}
