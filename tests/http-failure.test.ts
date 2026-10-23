/**
 * 目录失败原因透传（`describeHttpFailure`）。
 *
 * 真实缺陷（2026-10-23）：目录刷新只写 `"目录 HTTP " + status`，把响应体丢掉。
 * 用户看到「目录 HTTP 403」而无法归因 —— 403 同时覆盖「凭据失效 / 账号被禁用 /
 * 额度耗尽 / 无权限」四种语义。与额度查询的 `describeCreditFailure` 同源问题。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeHttpFailure } from "../src/core/types.ts";

test("业务码与 message 都带出来", () => {
  const text = describeHttpFailure(
    "目录",
    403,
    '{"code":40302,"message":"账号已被禁用"}',
  );
  assert.match(text, /目录 HTTP 403/);
  assert.match(text, /40302/);
  assert.match(text, /账号已被禁用/);
});

test("常见的 msg / error_code / error_msg / error 字段名都能读", () => {
  assert.match(describeHttpFailure("目录", 400, '{"code":1,"msg":"参数不合法"}'), /参数不合法/);
  assert.match(
    describeHttpFailure("目录", 401, '{"error_code":"APIG.0301","error_msg":"签名失败"}'),
    /签名失败/,
  );
  assert.match(describeHttpFailure("目录", 500, '{"error":"上游炸了"}'), /上游炸了/);
});

test("Gemini 的地区限制文案被完整带出（这正是只报状态码读不出的信息）", () => {
  const text = describeHttpFailure(
    "Gemini 目录",
    403,
    '{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"UNSUPPORTED_LOCATION"}]}}',
  );
  assert.match(text, /Gemini 目录 HTTP 403/);
  // 该响应的 error 是对象而非字符串：应退回原文片段，而不是丢掉整个响应体。
  assert.match(text, /UNSUPPORTED_LOCATION/);
});

test("非 JSON（网关 HTML 页）保留一段原文", () => {
  const html = "<html><head><title>401 Authorization Required</title></head></html>";
  const text = describeHttpFailure("目录", 401, html);
  assert.match(text, /目录 HTTP 401/);
  assert.match(text, /401 Authorization Required/);
});

test("响应体为空时只报状态码，不编造原因", () => {
  assert.equal(describeHttpFailure("目录", 503, ""), "目录 HTTP 503");
  assert.equal(describeHttpFailure("目录", 503, "   "), "目录 HTTP 503");
});

test("解析成功但无可读字段时退回原文，而不是静默只剩状态码", () => {
  const text = describeHttpFailure("目录", 404, '{"unexpected":true}');
  assert.match(text, /目录 HTTP 404/);
  assert.match(text, /unexpected/);
});

test("长响应体被截断，不会把整页塞进读数", () => {
  const huge = "x".repeat(5000);
  assert.ok(describeHttpFailure("目录", 500, huge).length < 400);
});
