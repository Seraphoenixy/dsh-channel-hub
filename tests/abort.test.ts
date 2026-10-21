import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/core/types.ts";
import { Observer } from "../src/core/observer.ts";
import type { Store } from "../src/storage/client.ts";

/**
 * 中断语义与错误记录的可读性（真实缺陷，2026-10-21 用户报障「偶发
 * `This operation was aborted`」）。
 *
 * 运行日志自查发现两类记录缺陷：
 * 1. `error` 里出现字面量 `[object Object]` —— 宿主把中断归类成普通对象，
 *    旧的 `redact` 只认 `error.message`；
 * 2. 适配器**正常收尾**时 `cancel()` 被一律记成 `cancelled`，于是日志里全是
 *    用户看不懂的 `This operation was aborted`，真正的上游故障被掩盖。
 *
 * 夹具全部为内存替身，不联网、不读真实账号。
 */

interface Write {
  method: string;
  args: any[];
}

/** 只记录写入的内存 Store。 */
function memoryStore(): { writes: Write[]; store: Store } {
  const writes: Write[] = [];
  return {
    writes,
    store: {
      async call(method: string, ...args: any[]): Promise<any> {
        writes.push({ method, args });
        return undefined;
      },
    } as Store,
  };
}

const silent = { warn(): void {}, info(): void {} };

/** 收集 async iterable 的所有 chunk。 */
async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test("redact renders plain objects instead of [object Object]", () => {
  // 宿主中断时传进来的就是这种普通对象。
  assert.equal(redact({ message: "boom", code: "ABORTED" }), "boom");
  assert.equal(redact({ msg: "服务端拒绝" }), "服务端拒绝");
  // 没有 message/msg 时退到 JSON，而不是 `[object Object]`。
  const json = redact({ code: "ABORTED", kind: "aborted" });
  assert.match(json, /ABORTED/);
  assert.ok(!json.includes("[object Object]"), json);
  // 嵌套 reason.failure 这类形状也能读出一句人话。
  assert.equal(redact({ reason: "上游断流" }), "上游断流");
});

test("redact names aborts and timeouts instead of leaking bare English", () => {
  const aborted = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  assert.match(redact(aborted), /^请求已取消/);
  assert.match(redact(aborted), /This operation was aborted/);

  const timedOut = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.match(redact(timedOut), /^请求超时/);
});

test("redact reaches through reason/cause/failure wrappers to the real reason", () => {
  // 宿主与 undici 都会把真正的错误包在 `reason` / `cause` 里；直接 JSON 化会
  // 得到 `{}`（Error 的字段不可枚举），用户因此看不到任何原因。
  const controller = new AbortController();
  controller.abort();
  assert.match(redact({ reason: controller.signal.reason }), /请求已取消/);
  assert.equal(redact({ cause: new Error("upstream reset") }), "upstream reset");
  assert.equal(
    redact({ failure: { message: "boom", code: "ABORTED" } }),
    "boom",
  );
  // 空对象不该产出 `{}` 这种无信息的东西。
  assert.ok(!redact({}).includes("{}"), redact({}));
});

test("redact still hides credentials and never throws on hostile values", () => {
  assert.match(
    redact(new Error("Authorization: Bearer sk-secret-123")),
    /\[REDACTED\]/,
  );
  assert.ok(!redact(new Error("access_token=abc123")).includes("abc123"));
  // 循环引用 + 无 message 的对象：不能抛，也不能是 [object Object]。
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const text = redact(cyclic);
  assert.ok(!text.includes("[object Object]"), text);
  // null/undefined 不应产出 "null"/"undefined" 这种无信息的字面量。
  assert.ok(!/^(null|undefined)$/.test(redact(null)));
  assert.ok(!/^(null|undefined)$/.test(redact(undefined)));
});

test("a normally completed stream is recorded as success, not cancelled", async () => {
  // 适配器读完 finish 帧就 return（不消费到 done），上层随之 cancel body。
  // 旧实现会把它记成 cancelled + `This operation was aborted`。
  const { writes, store } = memoryStore();
  const observer = new Observer(store, silent);
  const chunks = await drain(
    observer.stream("buddy", "m", async function* () {
      yield { type: "text-delta", index: 0, text: "hi" };
      yield { type: "finish", reason: { kind: "stop" } };
      // 刻意不继续 yield：让消费方提前结束并进入 finally 的清理 abort。
    }),
  );
  assert.equal(chunks.length, 2);
  const finish = writes.filter((w) => w.method === "finish");
  assert.equal(finish.length, 1);
  assert.equal(
    finish[0].args[0].outcome,
    "success",
    "a stream that ended on its own must not be labelled cancelled",
  );
  assert.equal(finish[0].args[0].error, undefined);
});

test("a caller abort is recorded as cancelled with a readable Chinese reason", async () => {
  const { writes, store } = memoryStore();
  const observer = new Observer(store, silent);
  const controller = new AbortController();
  await assert.rejects(async () => {
    await drain(
      observer.stream(
        "buddy",
        "m",
        async function* () {
          yield { type: "text-delta", index: 0, text: "partial" };
          controller.abort();
          throw controller.signal.reason;
        },
        controller.signal,
      ),
    );
  });
  const finish = writes.filter((w) => w.method === "finish").at(-1)!;
  assert.equal(finish.args[0].outcome, "cancelled");
  assert.match(
    String(finish.args[0].error),
    /请求已取消（用户停止）/,
    "the reason must be readable, not bare English",
  );
});

test("an upstream failure is recorded as failed with its real reason", async () => {
  // 关键回归：没有取消来源的异常**不得**被抹成 cancelled。
  const { writes, store } = memoryStore();
  const observer = new Observer(store, silent);
  await assert.rejects(async () => {
    await drain(
      observer.stream("buddy", "m", async function* () {
        throw new Error("socket hang up");
      }),
    );
  });
  const finish = writes.filter((w) => w.method === "finish").at(-1)!;
  assert.equal(finish.args[0].outcome, "failed");
  assert.equal(finish.args[0].error, "socket hang up");
});

test("close() marks in-flight requests as interrupted by the plugin", async () => {
  const { writes, store } = memoryStore();
  const observer = new Observer(store, silent);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const running = drain(
    observer.stream("buddy", "m", async function* (signal?: AbortSignal) {
      started();
      // 永不主动结束：只能被 close() 打断。
      await new Promise<void>((resolve) => {
        if (signal === undefined) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal?.reason ?? new Error("aborted");
    }),
  ).catch(() => {});
  await ready;
  await observer.close();
  await running;
  const finish = writes.filter((w) => w.method === "finish").at(-1)!;
  assert.equal(finish.args[0].outcome, "cancelled");
  assert.match(
    String(finish.args[0].error),
    /插件已停止/,
    "a plugin-driven interruption must say so, not blame the model",
  );
});

test("observer.fetcher does not turn a normal teardown into a cancelled attempt", async () => {
  // 还原真实链路：适配器读了几帧就 return，响应体随即被 cancel。
  const { writes, store } = memoryStore();
  const observer = new Observer(store, silent);
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const base = async (): Promise<Response> =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          // 不 close：由消费方 cancel。
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  await observer.context.run(
    {
      request: {
        id: "r1",
        provider: "buddy",
        model: "m",
        started: Date.now(),
        outcome: "running",
      },
      attempts: [],
      accountId: "a1",
    },
    async () => {
      const response = await observer.fetcher(base)(
        "https://example.test/chat/completions",
        { method: "POST", body: "{}" },
      );
      const reader = response.body!.getReader();
      await reader.read();
      // 模拟适配器拿到内容后主动释放连接。
      await reader.cancel();
    },
  );
  const attempts = writes.filter((w) => w.method === "attempt").at(-1)!;
  assert.equal(
    attempts.args[0].outcome,
    "success",
    "a normal teardown must not be recorded as a cancelled attempt",
  );
  assert.equal(attempts.args[0].error, undefined);
});
