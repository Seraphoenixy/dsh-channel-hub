import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProbeOutcome,
  effectiveVersion,
  ladderCandidates,
  probeIntervalMs,
  rollbackAdoption,
  runVersionProbe,
  type CandidateOutcome,
  type DeclaredVersionState,
} from "../src/core/declared-version.ts";

const state = (overrides: Partial<DeclaredVersionState> = {}): DeclaredVersionState => ({
  baseline: "1.1.38",
  rejected: [],
  ...overrides,
});

test("ladder covers two patches, three minors and one major, ascending", () => {
  assert.deepEqual(ladderCandidates("1.1.38"), [
    "1.1.39",
    "1.1.40",
    "1.2.0",
    "1.3.0",
    "1.4.0",
    "2.0.0",
  ]);
  assert.deepEqual(ladderCandidates("2.0.5"), [
    "2.0.6",
    "2.0.7",
    "2.1.0",
    "2.2.0",
    "2.3.0",
    "3.0.0",
  ]);
  // 形状不对宁可不探测：不猜未知形状的版本。
  assert.deepEqual(ladderCandidates("1.2"), []);
  assert.deepEqual(ladderCandidates("abc"), []);
});

test("probe adopts the lowest candidate reaching the maximal model set", async () => {
  // 1.2.0 与 1.3.0 都给出同一个最大集；采纳更低的 1.2.0。
  const seen: string[] = [];
  const outcome = await runVersionProbe({
    state: state(),
    currentIds: ["a", "b"],
    fetchCandidate: async (version): Promise<CandidateOutcome> => {
      seen.push(version);
      if (version === "1.1.39" || version === "1.1.40")
        return { ok: true, ids: ["a", "b"] };
      return { ok: true, ids: ["a", "b", "c", "d"] };
    },
  });
  assert.equal(seen.length, 6);
  assert.deepEqual(outcome.adopted, { version: "1.2.0", from: "1.1.38", added: 2 });
  assert.equal(outcome.hardRejected.length, 0);
  assert.equal(outcome.checked, 6);
});

test("probe requires a strict gain: identical sets never change identity", async () => {
  const outcome = await runVersionProbe({
    state: state(),
    currentIds: ["a", "b"],
    fetchCandidate: async () => ({ ok: true, ids: ["a", "b"] }),
  });
  assert.equal(outcome.adopted, undefined);
});

test("candidates that lose existing models are hard-rejected, not adopted", async () => {
  const outcome = await runVersionProbe({
    state: state(),
    currentIds: ["a", "b"],
    fetchCandidate: async (version): Promise<CandidateOutcome> =>
      version === "2.0.0"
        ? { ok: true, ids: ["a"] } // 缺 b：倒退
        : { ok: true, ids: ["a", "b"] },
  });
  assert.equal(outcome.adopted, undefined);
  assert.deepEqual(
    outcome.hardRejected.map((r) => r.version),
    ["2.0.0"],
  );
  assert.match(outcome.hardRejected[0].reason, /缺少既有模型/);
});

test("request-level failures (4xx/5xx/network) are transient and never remembered", async () => {
  // 真实缺陷修正（2026-11-08）：探测每轮并发打同一端点，最容易被限流的
  // 恰是这批请求；把 429/403 等状态类失败记成硬拒绝会让候选阶梯被一次
  // 限流永久拉黑。请求级失败一律瞬态，硬拒绝只留给「候选缺既有模型」
  // 这种确定性结果（见上一条用例）。
  const outcome = await runVersionProbe({
    state: state(),
    currentIds: ["a"],
    fetchCandidate: async (version): Promise<CandidateOutcome> => {
      if (version === "1.1.39") return { ok: false, transient: true, reason: "目录 HTTP 403" };
      if (version === "1.1.40") return { ok: false, transient: true, reason: "目录 HTTP 429" };
      return { ok: true, ids: ["a", "c"] };
    },
  });
  assert.equal(outcome.adopted?.version, "1.2.0");
  assert.equal(outcome.hardRejected.length, 0);
  assert.equal(outcome.checked, 6);
});

test("previously hard-rejected versions are skipped in later rounds", async () => {
  const probed: string[] = [];
  await runVersionProbe({
    state: state({
      rejected: [{ version: "1.1.39", at: 1, reason: "目录 HTTP 403" }],
    }),
    currentIds: ["a"],
    fetchCandidate: async (version): Promise<CandidateOutcome> => {
      probed.push(version);
      return { ok: false, transient: true, reason: "目录 HTTP 502" };
    },
  });
  assert.equal(probed.includes("1.1.39"), false);
  assert.equal(probed.length, 5);
});

test("applyProbeOutcome persists adoption and keeps the rejection log bounded", async () => {
  const now = 1_700_000_000_000;
  const outcome = await runVersionProbe(
    {
      state: state(),
      currentIds: ["a"],
      fetchCandidate: async () => ({ ok: true, ids: ["a", "b"] }),
    },
    now,
  );
  let next = applyProbeOutcome(state(), outcome, now);
  assert.deepEqual(next.adopted, { version: "1.1.39", adoptedAt: now, from: "1.1.38" });
  // 采纳后的生效版本指向新候选；回滚清掉采纳但保留拒绝记录。
  assert.equal(effectiveVersion(next), "1.1.39");
  next = rollbackAdoption(next);
  assert.equal(effectiveVersion(next), "1.1.38");
  assert.equal(next.adopted, undefined);
  // 拒绝记录有界：塞 60 条只留最近 50 条。
  const flooded = applyProbeOutcome(
    state({ rejected: Array.from({ length: 60 }, (_, i) => ({ version: "v" + i, at: i, reason: "x" })) }),
    {
      hardRejected: [{ version: "late", at: now, reason: "y" }],
      checked: 1,
    },
    now,
  );
  assert.equal(flooded.rejected.length, 50);
  assert.equal(flooded.rejected.at(-1)?.version, "late");
});

test("probeIntervalMs defaults to a day and honours the test override", () => {
  assert.equal(probeIntervalMs({}), 24 * 60 * 60 * 1000);
  assert.equal(probeIntervalMs({ CHANNEL_HUB_VERSION_PROBE_MIN_MS: "0" }), 0);
  assert.equal(probeIntervalMs({ CHANNEL_HUB_VERSION_PROBE_MIN_MS: "5000" }), 5000);
  // 非法值回默认，不会把 NaN 当 0 用。
  assert.equal(probeIntervalMs({ CHANNEL_HUB_VERSION_PROBE_MIN_MS: "abc" }), 24 * 60 * 60 * 1000);
});
