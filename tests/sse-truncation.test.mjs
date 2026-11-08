import test from "node:test";
import assert from "node:assert/strict";
import { isTruncatedArguments, normalizeToolArguments } from "../vendor/ofm/src/sse.ts";

/**
 * 工具参数截断判据（2026-11-08 随上游移植，上游 issue #474）：
 *
 * 「无法解析」要再分两类 —— **结构不完整**（字符串未闭合、括号不平衡，被
 * 输出上限切断或分片丢失）才是截断；**结构完整但语法非法**（如值裸写漏引号）
 * 不是截断：判成截断会冒充「已达到输出 token 上限」误导用户，且把参数补成
 * `{}` 会伪造出合法外观，让 harness 报 missing required property 而不是把
 * 真实病因回传给模型。
 */

test("isTruncatedArguments: structurally incomplete JSON is truncation", () => {
  // 字符串未闭合（被输出上限切断）。
  assert.equal(isTruncatedArguments('{"file_path": "src/a'), true);
  // 括号不平衡（丢了尾部）。
  assert.equal(isTruncatedArguments('{"a": {"b": 1'), true);
  assert.equal(isTruncatedArguments("[1, 2"), true);
  // 深度为负：丢了前缀只剩中段与尾部的分片丢失形态，必须留在截断恢复路径上。
  assert.equal(isTruncatedArguments('"path.txt"}'), true);
});

test("isTruncatedArguments: syntactically invalid but structurally complete JSON is NOT truncation", () => {
  // 值裸写漏引号：括号平衡、无未闭合字符串 —— 结构完整，语法非法。
  assert.equal(isTruncatedArguments('{"path": bad}'), false);
  assert.equal(isTruncatedArguments("{a: 1}"), false);
});

test("isTruncatedArguments: parseable JSON and empty strings are never truncation", () => {
  assert.equal(isTruncatedArguments('{"file_path": "a.txt"}'), false);
  assert.equal(isTruncatedArguments("null"), false);
  assert.equal(isTruncatedArguments("42"), false);
  assert.equal(isTruncatedArguments(""), false);
  assert.equal(isTruncatedArguments("   "), false);
});

test("normalizeToolArguments: truncation falls back to {}, syntax errors pass through", () => {
  // 截断：补 {}（历史序列化路径上 wire 必须是合法 JSON）。
  assert.equal(normalizeToolArguments('{"file_path": "src/a'), "{}");
  // 结构完整的语法错误：原样返回，把真实病因交给 schema 校验回传给模型。
  assert.equal(normalizeToolArguments('{"path": bad}'), '{"path": bad}');
});

test("normalizeToolArguments: existing contracts unchanged", () => {
  assert.equal(normalizeToolArguments(""), "{}");
  assert.equal(normalizeToolArguments('{"a": 1}'), '{"a": 1}');
  assert.equal(normalizeToolArguments('  {"a": 1}  '), '{"a": 1}');
  // null / 数组 / 标量都不是合法参数包。
  assert.equal(normalizeToolArguments("null"), "{}");
  assert.equal(normalizeToolArguments("[1, 2]"), "{}");
  assert.equal(normalizeToolArguments("42"), "{}");
});
