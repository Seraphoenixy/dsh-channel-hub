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
}
/** 调用方补充的上下文（DSH 只给 sessionId，轮次由本插件推断）。 */
export interface StreamMeta {
  sessionId?: string;
  startsTurn?: boolean;
}
export class Observer {
  readonly context = new AsyncLocalStorage<Scope>();
  private active = new Map<AbortController, Promise<void>>();
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
    let release!: () => void;
    this.active.set(controller, new Promise<void>((r) => (release = r)));
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
      req.outcome = combined.aborted ? "cancelled" : "failed";
      req.error = redact(e);
      if (scope.current) {
        scope.current.outcome = req.outcome;
        scope.current.error = req.error;
      }
      throw e;
    } finally {
      if (!completed) {
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
    }
  }
  async close() {
    const work = [...this.active.entries()];
    for (const [controller] of work) controller.abort();
    await Promise.all(work.map(([, promise]) => promise));
  }
  isIdle() {
    return this.active.size === 0;
  }
  async whenIdle() {
    // A new request may start while the preceding one is being finalized.
    while (this.active.size)
      await Promise.all([...this.active.values()]);
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
              await finish(init?.signal?.aborted ? "cancelled" : "failed", e);
              controller.error(e);
            }
          },
          cancel: async (reason) => {
            await reader.cancel(reason);
            await finish("cancelled");
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
