/**
 * 额度查询失败原因的归一化（`vendor/ofm/src/credits.ts` 的 `describeCreditFailure`）。
 *
 * 这个函数是所有渠道共用的：它的目标只有一个 —— **别把上游已经说清楚的
 * 原因弄丢**。真实故障背景：LobsterAI 账号被禁用，上游返回
 * `{"code":40302,"message":"账号已被禁用"}`，旧实现只 `return null`，
 * 界面显示「凭据失效或响应异常」，把用户引向「重新登录」这个无效动作。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeCreditFailure } from "../vendor/ofm/src/credits.ts";

test("上游的 code 与 message 都被带出来", () => {
  const text = describeCreditFailure(403, '{"code":40302,"message":"账号已被禁用"}');
  assert.match(text, /HTTP 403/);
  assert.match(text, /40302/);
  assert.match(text, /账号已被禁用/);
});

test("常见的 msg / error_code / error_msg 字段名都能读", () => {
  assert.match(describeCreditFailure(400, '{"code":10001,"msg":"今天已签到"}'), /今天已签到/);
  assert.match(describeCreditFailure(500, '{"error_code":"APIG.0301","error_msg":"签名失败"}'), /签名失败/);
  assert.match(describeCreditFailure(402, '{"error":"额度耗尽"}'), /额度耗尽/);
});

test("非 JSON 响应保留一段原文，而不是只说状态码", () => {
  const html = "<html><head><title>401 Authorization Required</title></head></html>";
  const text = describeCreditFailure(401, html);
  assert.match(text, /HTTP 401/);
  assert.match(text, /401 Authorization Required/);
});

test("响应体为空时给出状态码；401/403 单独点名「凭据或账号被拒」", () => {
  assert.equal(describeCreditFailure(503, ""), "额度查询失败（HTTP 503）");
  assert.match(describeCreditFailure(401, ""), /凭据或账号被拒/);
  assert.match(describeCreditFailure(403, ""), /凭据或账号被拒/);
});

test("状态码未知时用调用方给的兜底说明", () => {
  assert.equal(
    describeCreditFailure(0, "", "响应里没有任何额度包"),
    "响应里没有任何额度包",
  );
});

test("片段长度受限，避免把整页 HTML 塞进读数", () => {
  const huge = "x".repeat(5000);
  assert.ok(describeCreditFailure(500, huge).length < 400);
});
