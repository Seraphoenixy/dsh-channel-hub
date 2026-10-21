import { Worker } from "node:worker_threads";

export interface Store {
  call<T = any>(method: string, ...args: any[]): Promise<T>;
}

/** 单次调用的超时（毫秒）。默认 5000；`DSH_CHANNEL_HUB_STORE_TIMEOUT_MS` 可覆盖。 */
export const STORE_TIMEOUT_ENV = "DSH_CHANNEL_HUB_STORE_TIMEOUT_MS";
/** 未完成调用的上限。默认 200；`DSH_CHANNEL_HUB_STORE_MAX_PENDING` 可覆盖。 */
export const STORE_MAX_PENDING_ENV = "DSH_CHANNEL_HUB_STORE_MAX_PENDING";

/** 工作线程的最小契约（测试可注入替身）。 */
export interface WorkerLike {
  on(event: "message" | "error" | "exit", listener: (value: any) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<number> | number | void;
}

const positive = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/**
 * 记账工作线程的客户端。
 *
 * ⚠️ **记账故障不得拖住推理**。此前只依赖工作线程的 `error`/`exit` 事件：
 * 线程卡死时 `call` 会无限等待（观察者的 `await write(...)` 把整轮请求挂住），
 * 线程在发 `ready` 之前退出时初始化 Promise 也永远不落定。故补齐三件事：
 *
 * 1. **初始化失败即失败**：`ready` 之前退出 / 抛错都让 `ready` 直接 reject；
 * 2. **单次调用超时**：超时即 reject 并摘掉该 id（迟到的回包会被丢弃）；
 * 3. **排队上限**：未完成调用超过上限时立刻失败，而不是把调用方越堆越深。
 *
 * 调用方（观察者）本来就把失败记成 `failedWrites` 并继续，所以这些拒绝只影响
 * 记账，不影响模型输出。
 */
export class WorkerStore implements Store {
  private worker: WorkerLike;
  private seq = 0;
  private pending = new Map<number, Pending>();
  readonly ready: Promise<void>;
  private failure?: Error;
  private settled = false;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(file: string, worker?: WorkerLike) {
    this.timeoutMs = positive(process.env[STORE_TIMEOUT_ENV], 5000);
    this.maxPending = positive(process.env[STORE_MAX_PENDING_ENV], 200);
    this.worker =
      worker ??
      new Worker(new URL("./ledger-worker.js", import.meta.url), {
        workerData: { file },
      });
    this.ready = new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        if (this.settled) {
          this.failure ??= error;
          return;
        }
        this.settled = true;
        this.failure = error;
        reject(error);
      };
      this.worker.on("message", (m: any) => {
        if (m?.ready) {
          if (!this.settled) {
            this.settled = true;
            resolve();
          }
          return;
        }
        const p = this.pending.get(m?.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
      });
      this.worker.on("error", (e: Error) => {
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        fail(e);
      });
      this.worker.on("exit", (code: number) => {
        const error = Error("Database worker exited: " + code);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        // 关键：ready 之前就退出时也必须让初始化落定，否则 `call` 永久悬挂。
        fail(error);
      });
    });
    // 没人 await 的早期失败不能变成进程级 unhandledRejection；
    // 后续 `await this.ready` 依旧会拿到同一个拒绝。
    void this.ready.catch(() => {});
  }

  async call<T = any>(method: string, ...args: any[]): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending.size >= this.maxPending)
      throw Error(
        `记账队列已满（${this.maxPending} 个未完成调用），本次跳过：${method}`,
      );
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(Error(`记账超时（${this.timeoutMs}ms）：${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.worker.postMessage({ id, method, args });
    });
  }

  async close() {
    // 关停路径不允许抛错：线程已经退出 / 超时都不该阻断插件停止。
    try {
      await this.call("close");
    } catch {
      /* 记账已不可用，直接终止 */
    } finally {
      await this.worker.terminate();
    }
  }
}
