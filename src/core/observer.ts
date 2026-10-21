import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  redact,
  normalizeUsage,
  type Attempt,
  type RequestRow,
  type Logger,
} from "./types.ts";
import type { Store } from "../storage/client.ts";
interface Scope {
  request: RequestRow;
  attempts: Attempt[];
  accountId: string;
  accountName?: string;
  current?: Attempt;
  emitted?: boolean;
  /**
   * 本次请求是被谁取消的（`undefined` = 还没有人取消）。
   *
   * ⚠️ 挂在 scope 上而不是 Observer 实例上：Observer 是**单例**，并发请求
   * 共用它，实例级标记会把"A 请求被取消"传染给同时进行的 B 请求。
   */
  abortSource?: "caller" | "plugin";
}
/** 调用方补充的上下文（DSH 只给 sessionId，轮次由本插件推断）。 */
export interface StreamMeta {
  sessionId?: string;
  startsTurn?: boolean;
}
/**
 * 取消原因的中文说明（保留原始文本作为括注）。
 *
 * ⚠️ 存在的理由：上游/宿主给的取消原文是英文的 `This operation was aborted`
 * 或 `AbortError: ...`，用户看不出这是"自己按了停止"还是"插件重启了"，
 * 更看不出"这条不是模型故障"（真实缺陷，2026-10-21 用户报障）。
 * 保留括注是为了排查时仍能与宿主日志逐字对上。
 */
function cancelMessage(source: "caller" | "plugin" | undefined, error: unknown): string {
  const original = redact(error);
  if (source === "caller")
    return original.length > 0 ? "请求已取消（用户停止）：" + original : "请求已取消（用户停止）";
  if (source === "plugin")
    return original.length > 0
      ? "插件已停止，本次请求中断：" + original
      : "插件已停止，本次请求中断";
  return original.length > 0 ? "请求已中断：" + original : "请求已中断";
}
export class Observer {
  readonly context = new AsyncLocalStorage<Scope>();
  /**
   * 进行中的请求：controller → { 完成信号, 取消来源标记 }。
   *
   * ⚠️ 需要 markAbort 而不只是 promise：`close()` 必须能告诉每个请求
   * "这次中断是插件停止造成的"，否则日志里只会留下宿主/Node 的英文原文
   * （真实缺陷，2026-10-21）。
   */
  private active = new Map<
    AbortController,
    { done: Promise<void>; markAbort: (source: "caller" | "plugin") => void }
  >();
  /** 会话 → 当前轮次 id（用于把同一条用户消息的多次调用归到一轮）。 */
  private turns = new Map<string, string>();
  health = { failedWrites: 0, lastError: "" };
  constructor(
    readonly store: Store,
    private logger: Logger,
  ) {}
  private async write(method: string, ...args: any[]) {
    try {
      await this.store.call(method, ...args);
    } catch (e) {
      this.health.failedWrites++;
      this.health.lastError = redact(e);
      this.logger.warn("渠道中心记录异常：" + this.health.lastError);
    }
  }
  bindAccount(id: string, name?: string) {
    const s = this.context.getStore();
    if (s) {
      s.accountId = id;
      s.accountName = name;
    }
  }
  /**
   * 本轮调用的轮次 id。
   *
   * DSH 只下发 `sessionId`，不向适配器提供 turn/step；故按「最后一条消息是不是
   * 纯用户消息」推断轮次边界：是则本轮以该请求 id 开新轮，否则沿用该会话当前轮。
   * 没有会话 id 的调用（如直接探针）各自成轮，行为与按步统计一致。
   *
   * ⚠️ 已知近似：压缩/标题生成等旁路调用若也以用户消息结尾，会被当成新的一轮。
   */
  private turnFor(meta: StreamMeta | undefined, id: string): string {
    const session = meta?.sessionId;
    if (!session) return id;
    const current = this.turns.get(session);
    if (meta?.startsTurn === true || current === undefined) {
      // 会话数量有界：撑到上限时整体清空，最坏只是丢掉「当前轮」的记忆。
      if (this.turns.size > 500) this.turns.clear();
      this.turns.set(session, id);
      return id;
    }
    return current;
  }
  async *stream(
    provider: string,
    model: string,
    run: (signal?: AbortSignal) => AsyncIterable<any>,
    signal?: AbortSignal,
    meta?: StreamMeta,
  ) {
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    /**
     * 本次请求**是被谁取消的**。
     *
     * ⚠️ 只用 `combined.aborted` 判断会把三种完全不同的情形混成一个
     * "cancelled"，而且会**覆盖真实错误**（真实缺陷，2026-10-21）：
     *
     * | 来源 | 含义 | 用户该看到的中文 |
     * |---|---|---|
     * | 调用方 signal | 用户按了停止 / 切换会话 | 请求已取消 |
     * | 本插件 close/重载 | 插件停止或热重载 | 插件已停止，本次请求中断 |
     * | 都不是 | 上游断流 / 网络中断 | 保留原始原因（多为 transport） |
     *
     * 第三行尤其重要：`finally` 里的 `controller.abort()` 会给仍在读取的
     * 迭代器抛 `AbortError("This operation was aborted")`，若照旧记成
     * cancelled，日志里就只剩一句用户看不懂的英文，真正的上游原因被掩盖。
     */
    let abortSource: "caller" | "plugin" | undefined;
    /**
     * 记下取消来源。
     *
     * ⚠️ 必须**同时**写 scope 与局部变量：`observer.fetcher` 包出来的响应体
     * 在 `cancel` 回调里读的是 scope（它拿不到本函数闭包），而 `catch` /
     * `finally` 读的是局部变量。
     */
    const markAbort = (source: "caller" | "plugin") => {
      abortSource ??= source;
      const current = this.context.getStore();
      if (current !== undefined) current.abortSource ??= source;
    };
    const noteCallerAbort = () => {
      markAbort("caller");
    };
    signal?.addEventListener("abort", noteCallerAbort, { once: true });
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    this.active.set(controller, { done, markAbort });
    const req: RequestRow = {
      id: randomUUID(),
      provider,
      model,
      started: Date.now(),
      outcome: "running",
      ...(meta?.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
    };
    req.turnId = this.turnFor(meta, req.id);
    if (meta?.startsTurn === true) req.startsTurn = true;
    const scope: Scope = { request: req, attempts: [], accountId: "" };
    await this.write("begin", req);
    // ⚠️ 迭代器必须在 try 内创建：驱动完全可能同步抛错（参数校验、凭据缺失、
    // 适配器本身抛异常）。放在 try 外会让整个 finally 都不执行 —— 请求停在
    // running、`active` 槽位不释放，关闭与热重载会一直等它。
    let iterator: AsyncIterator<any> | undefined;
    let completed = false;
    try {
      iterator = this.context.run(scope, () =>
        run(combined)[Symbol.asyncIterator](),
      );
      while (true) {
        const next = await this.context.run(scope, () => iterator!.next());
        if (next.done) {
          completed = true;
          break;
        }
        this.observeChunk(scope, next.value);
        yield next.value;
      }
      if (req.outcome === "running")
        req.outcome = combined.aborted ? "cancelled" : "success";
    } catch (e) {
      // ⚠️ 只有**调用方或插件明确取消**才算 cancelled（真实缺陷，2026-10-21）。
      // 不能只看 `combined.aborted`：`finally` 里的清理 abort 也会让它为真，
      // 于是"上游断流"被抹成"已取消"，真实原因就此丢失。
      // 没有取消来源时按失败记原始原因。
      const cancelled = abortSource !== undefined;
      req.outcome = cancelled ? "cancelled" : "failed";
      // 取消时给一句人能看懂的中文，而不是 `This operation was aborted`；
      // 保留原始文本作为括注，便于与宿主日志逐字对照。
      req.error = cancelled ? cancelMessage(abortSource, e) : redact(e);
      if (scope.current) {
        scope.current.outcome = req.outcome;
        scope.current.error = req.error;
      }
      throw e;
    } finally {
      if (!completed) {
        // ⚠️ **不在这里 markAbort**：走到这里可能只是上游正常断流 / 适配器
        // 提前返回。标记来源只由真正的取消入口（调用方 signal、`close()`）
        // 设置，否则每个异常收尾都会被误标成"插件已停止"。
        controller.abort();
        const tail = iterator;
        if (tail)
          await this.context
            .run(scope, async () => {
              await tail.return?.();
            })
            .catch(() => {});
        if (req.outcome === "running") req.outcome = "cancelled";
      }
      req.ended = Date.now();
      await this.write("finish", req, scope.attempts);
      this.active.delete(controller);
      release();
      signal?.removeEventListener("abort", noteCallerAbort);
    }
  }
  async close() {
    // ⚠️ 逐个请求标记"插件停止"来源：这样 `catch` 才能把中断写成
    // 「插件已停止，本次请求中断」而不是裸的 `This operation was aborted`。
    for (const [, entry] of this.active) entry.markAbort("plugin");
    const work = [...this.active.entries()];
    for (const [controller] of work) controller.abort();
    await Promise.all(work.map(([, entry]) => entry.done));
  }
  isIdle() {
    return this.active.size === 0;
  }
  async whenIdle() {
    // A new request may start while the preceding one is being finalized.
    while (this.active.size)
      await Promise.all([...this.active.values()].map((entry) => entry.done));
  }
  private observeChunk(s: Scope, chunk: any) {
    const a = s.current;
    if (
      chunk.type === "finish" &&
      ["error", "aborted"].includes(chunk.reason?.kind)
    ) {
      s.request.outcome =
        chunk.reason.kind === "aborted" ? "cancelled" : "failed";
      s.request.error = redact(
        chunk.reason.failure?.message ?? chunk.reason.failure ?? "上游返回失败",
      );
      if (a) {
        a.outcome = s.request.outcome;
        a.error = s.request.error;
      }
    }
    if (!a) return;
    if (chunk.type === "usage") {
      const raw = chunk.usage ?? chunk;
      const normalized = normalizeUsage(raw);
      if (a.usage && raw.inputTokens === undefined)
        normalized.input = a.usage.input;
      if (a.usage && raw.outputTokens === undefined)
        normalized.output = a.usage.output;
      a.usage = {
        ...a.usage,
        ...Object.fromEntries(
          Object.entries(normalized).filter(([, v]) => v !== undefined),
        ),
      } as Attempt["usage"];
    }
    if (
      ["text-delta", "reasoning-delta", "tool-call-delta"].includes(
        chunk.type,
      ) &&
      (chunk.text || chunk.arguments || chunk.delta)
    ) {
      s.emitted = true;
      a.first ??= Date.now();
      if (chunk.type === "text-delta") a.firstText ??= Date.now();
    }
  }
  private inspectFrame(a: Attempt, text: string) {
    try {
      let frame = JSON.parse(text);
      if (frame?.body !== undefined)
        frame =
          typeof frame.body === "string" ? JSON.parse(frame.body) : frame.body;
      if (!frame || typeof frame !== "object") return;
      const error =
        frame.error ??
        (!Array.isArray(frame.choices) &&
        frame.code !== undefined &&
        !["0", "200"].includes(String(frame.code))
          ? (frame.message ?? frame.msg)
          : undefined);
      if (error) {
        a.outcome = "failed";
        a.error = redact(
          typeof error === "object" ? (error.message ?? error) : error,
        );
      }
      const usage = frame.usage ?? frame.message?.usage;
      if (!usage) return;
      const read =
        usage.prompt_tokens_details?.cached_tokens ??
        usage.prompt_cache_hit_tokens ??
        usage.cache_read_input_tokens;
      const write = usage.cache_creation_input_tokens;
      const input =
        usage.prompt_tokens !== undefined
          ? Math.max(0, usage.prompt_tokens - (read ?? 0))
          : usage.input_tokens;
      const output = usage.completion_tokens ?? usage.output_tokens;
      const previous = a.usage;
      const value = {
        input: input ?? previous?.input ?? 0,
        output: output ?? previous?.output ?? 0,
        cacheRead: read ?? previous?.cacheRead,
        cacheWrite: write ?? previous?.cacheWrite,
        reasoning:
          usage.completion_tokens_details?.reasoning_tokens ??
          previous?.reasoning,
        total: usage.total_tokens ?? previous?.total,
      };
      if (input !== undefined || output !== undefined || previous)
        a.usage = value;
    } catch {
      /* Forwarded bytes are untouched; unknown protocols are normalized by their driver. */
    }
  }
  fetcher(base: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const s = this.context.getStore();
      const url = input instanceof Request ? input.url : String(input);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        !s ||
        method.toUpperCase() !== "POST" ||
        !/(chat\/completions|agent_chat_generation|llm_utils_chat|streamGenerateContent|generateContent|\/messages(?:\?|$)|\/chat(?:\?|$)|completion|inference)/i.test(
          url,
        )
      )
        return base(input, init);
      if (s.emitted && s.attempts.length)
        throw Error("上游尝试已产生输出，禁止透明重放");
      const a: Attempt = {
        id: randomUUID(),
        requestId: s.request.id,
        provider: s.request.provider,
        model: s.request.model,
        accountId: s.accountId,
        accountName: s.accountName,
        started: Date.now(),
        outcome: "running",
      };
      s.attempts.push(a);
      s.current = a;
      await this.write("attempt", a);
      try {
        const response = await base(input, init);
        if (!response.ok) {
          a.outcome = "failed";
          a.error = "HTTP " + response.status;
          a.ended = Date.now();
          await this.write("attempt", a);
          return response;
        }
        if (!response.body) {
          a.outcome = "success";
          a.ended = Date.now();
          await this.write("attempt", a);
          return response;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let tail = "";
        const scan = (bytes?: Uint8Array) => {
          tail += decoder.decode(bytes, { stream: !!bytes });
          const lines = tail.split(/\r?\n/);
          tail = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data:"))
              this.inspectFrame(a, line.slice(5).trim());
          }
          if (tail.length > 65536) tail = "";
          if (!bytes && tail) {
            this.inspectFrame(
              a,
              tail.startsWith("data:") ? tail.slice(5).trim() : tail,
            );
            tail = "";
          }
        };
        const finish = async (outcome: Attempt["outcome"], error?: unknown) => {
          if (a.outcome !== "failed" || outcome !== "success")
            a.outcome = outcome;
          a.ended = Date.now();
          if (error) a.error = redact(error);
          await this.write("attempt", a);
        };
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const next = await reader.read();
              if (next.done) {
                scan();
                await finish("success");
                controller.close();
              } else {
                scan(next.value);
                controller.enqueue(next.value);
              }
            } catch (e) {
              // ⚠️ 这里的 abort 可能只是**适配器主动释放连接**（读到 finish
              // 就 return，上层随之 cancel body），也可能是真的被取消。区分
              // 依据是调用方 signal —— 只有它才是"用户取消"。
              await finish(init?.signal?.aborted ? "cancelled" : "failed", e);
              controller.error(e);
            }
          },
          cancel: async (reason) => {
            // ⚠️ **不要把 cancel 一律记成 cancelled**（真实缺陷，2026-10-21）：
            // 适配器正常收尾（拿到 finish 帧后停止读取）也会走到这里，那不是
            // 失败也不是取消 —— 记成 cancelled 会让日志里全是看不懂的
            // `This operation was aborted`，掩盖真正的上游故障。
            // 只有"调用方主动取消"或"本插件的 controller 已 abort"才算取消；
            // 其余按正常结束处理（attempt 已是 success/failed 时保留原值）。
            const aborted =
              init?.signal?.aborted === true || this.context.getStore()?.abortSource !== undefined;
            if (a.outcome === "running")
              await finish(aborted ? "cancelled" : "success", aborted ? reason : undefined);
            await reader.cancel(reason).catch(() => {});
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        a.outcome = init?.signal?.aborted ? "cancelled" : "failed";
        a.ended = Date.now();
        a.error = redact(e);
        await this.write("attempt", a);
        throw e;
      }
    }) as typeof fetch;
  }
  async *attempt(run: () => AsyncIterable<any>) {
    const s = this.context.getStore();
    if (!s) {
      yield* run();
      return;
    }
    const a: Attempt = {
      id: randomUUID(),
      requestId: s.request.id,
      provider: s.request.provider,
      model: s.request.model,
      accountId: s.accountId,
      accountName: s.accountName,
      started: Date.now(),
      outcome: "running",
    };
    s.attempts.push(a);
    s.current = a;
    await this.write("attempt", a);
    let done = false;
    try {
      for await (const chunk of run()) {
        if (chunk.type === "usage")
          a.usage = normalizeUsage(chunk.usage ?? chunk);
        if (
          [
            "text-delta",
            "reasoning-delta",
            "tool-call-delta",
            "text",
            "reasoning",
            "tool-call",
          ].includes(chunk.type)
        ) {
          a.first ??= Date.now();
          if (chunk.type.startsWith("text")) a.firstText ??= Date.now();
        }
        yield chunk;
      }
      done = true;
      a.outcome = "success";
    } catch (e) {
      a.error = redact(e);
      a.outcome = "failed";
      throw e;
    } finally {
      if (!done && a.outcome === "running") a.outcome = "cancelled";
      a.ended = Date.now();
      await this.write("attempt", a);
      s.current = undefined;
    }
  }
}
