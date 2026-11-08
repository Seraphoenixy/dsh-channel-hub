import test from "node:test";
import assert from "node:assert/strict";
import { QoderAdapter } from "../vendor/ofm/src/qoder-adapter.ts";
import { QODER } from "../vendor/ofm/src/qoder-product.ts";

/**
 * Qoder 排队等待的两条边界（2026-11-08 随上游移植，上游 2026-10-27 修）：
 *
 * 1. **单次等待钳制在剩余预算内**：一次较长的 Retry-After 不能越过
 *    `DSH_QODER_QUEUE_TIMEOUT_MS` 设定的总超时 —— 旧实现 `sleep(waitMs)`
 *    可以一次等过 deadline，醒来还带着一个注定超时的重放再跑一轮。
 * 2. **服务端给 0 时保底 100ms**：无间隔等待会退化成忙循环，瞬间烧掉
 *    `QUEUE_MAX_ATTEMPTS`。
 */

function makeAdapter(sleep) {
  return new QoderAdapter({
    product: QODER,
    resolveCredential: async () => undefined,
    refresh: async () => {},
    ...(sleep === undefined ? {} : { sleep }),
  });
}

test("waitForQueue clamps a long Retry-After to the remaining budget", async () => {
  const slept = [];
  const adapter = makeAdapter(async (ms) => {
    slept.push(ms);
  });
  const deadline = Date.now() + 150;
  // 服务端要求 60s（超过 QUEUE_MAX_DELAY_MS 后仍为 10s，都远大于剩余预算）。
  await adapter.waitForQueue({ isQueued: true, retry_after_ms: 60_000 }, 1, deadline, {});
  assert.equal(slept.length, 1);
  assert.ok(slept[0] <= 150, `sleep must be clamped to the remaining budget, got ${slept[0]}`);
  assert.ok(slept[0] > 0, "a positive server delay must not collapse to a zero wait");
});

test("waitForQueue keeps a 100ms floor when the server reports zero delay", async () => {
  const slept = [];
  const adapter = makeAdapter(async (ms) => {
    slept.push(ms);
  });
  const deadline = Date.now() + 5_000;
  await adapter.waitForQueue({ isQueued: true, retry_after_ms: 0 }, 1, deadline, {});
  assert.equal(slept.length, 1);
  assert.equal(slept[0], 100, "zero server delay must wait the 100ms floor, not busy-loop");
});

test("waitForQueue reports the timeout right after the budget is exhausted", async () => {
  // 真实计时：剩余预算 30ms，服务端要求 10s → 钳制成 ≈30ms，醒来立即超时，
  // 不再让「必然超时的重放」进入下一轮。
  const adapter = makeAdapter((ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 200))));
  const deadline = Date.now() + 30;
  await assert.rejects(
    adapter.waitForQueue({ isQueued: true, retry_after_ms: 10_000 }, 1, deadline, {}),
    (error) => {
      assert.match(String(error?.message), /排队等待超时/);
      assert.equal(error?.code, "QUEUE");
      return true;
    },
  );
});

test("waitForQueue throws before waiting once the deadline has passed", async () => {
  const slept = [];
  const adapter = makeAdapter(async (ms) => {
    slept.push(ms);
  });
  await assert.rejects(
    adapter.waitForQueue({ isQueued: true, retry_after_ms: 1_000 }, 1, Date.now() - 1, {}),
    /排队等待超时/,
  );
  assert.equal(slept.length, 0, "an expired deadline must not wait at all");
});
