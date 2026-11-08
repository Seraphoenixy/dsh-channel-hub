import test from "node:test";
import assert from "node:assert/strict";
import { qoderEffortsFor, sortEffortsByStrength } from "../vendor/ofm/src/qoder-adapter.ts";

/**
 * Qoder 档位按强度排序（2026-11-08 随上游移植）。
 *
 * 背景：目录的 `thinking_config.enabled.efforts` 键序是采集序（实测 `dfmodel`
 * 为 `high/max/low`），官方客户端拿到后还会按强度重排（CN 0.4.8 asar
 * `displayReasoningEfforts()`：稳定排序、未登记排末尾）。不重排的后果是
 * 依赖「位置 = 强度」的 UI（如 effort 滑条）把「最大」画在「高」左边、
 * 「关闭思考」点亮满格。
 */

test("sortEffortsByStrength orders by strength, not by directory key order", () => {
  // dfmodel 的真实键序：强 → 中 → 弱。
  assert.deepEqual(sortEffortsByStrength(["high", "max", "low"]), ["low", "high", "max"]);
  assert.deepEqual(sortEffortsByStrength(["max", "none", "medium"]), ["none", "medium", "max"]);
});

test("unregistered ids sort last and keep their relative order", () => {
  assert.deepEqual(
    sortEffortsByStrength(["custom-x", "low", "custom-y"]),
    ["low", "custom-x", "custom-y"],
  );
  // 与官方客户端 `?? ORDER.length` 同义：未知 id 彼此不换位。
  assert.deepEqual(sortEffortsByStrength(["z-unknown", "a-unknown"]), ["z-unknown", "a-unknown"]);
});

test("equal ranks keep the original order (stable sort)", () => {
  // `on` 与 `high` 同序（强度序表刻意如此），必须保持原相对顺序。
  assert.deepEqual(sortEffortsByStrength(["on", "high"]), ["on", "high"]);
  assert.deepEqual(sortEffortsByStrength(["high", "on"]), ["high", "on"]);
});

test("empty and single-element inputs pass through", () => {
  assert.deepEqual(sortEffortsByStrength([]), []);
  assert.deepEqual(sortEffortsByStrength(["max"]), ["max"]);
});

test("qoderEffortsFor appends none at the sorted front, not the tail", () => {
  // supportsDisable 为真时追加 none；排序后「关闭思考」在最左，
  // 而不是旧实现里「追加在目录键序末尾」。
  assert.deepEqual(
    qoderEffortsFor({ efforts: ["high", "max", "low"], supportsDisable: true }),
    ["none", "low", "high", "max"],
  );
  // 已含 none 的模型不重复追加。
  assert.deepEqual(
    qoderEffortsFor({ efforts: ["low", "none"], supportsDisable: true }),
    ["none", "low"],
  );
});

test("qoderEffortsFor keeps the remote facts for models without efforts", () => {
  // qmodel / qmodel_latest：「有 disabled 无 efforts」→ 只有关闭思考一项（远端事实，不补默认档）。
  assert.deepEqual(qoderEffortsFor({ supportsDisable: true }), ["none"]);
  // 两者皆无 → 空数组，调用方不声明 reasoning。
  assert.deepEqual(qoderEffortsFor({}), []);
});
