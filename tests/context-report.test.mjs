import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../vendor/ofm/src/gemini-adapter.ts";
import { GEMINI, GEMINI_CONTEXT_WINDOW, GEMINI_UPSTREAM_FLASH } from "../vendor/ofm/src/gemini.ts";
import { parseGeminiCatalog } from "../src/drivers/gemini-catalog.ts";
import { CodeArtsAdapter } from "../vendor/ofm/src/llm-adapter.ts";
import {
  CODEARTS_BENEFIT_FALLBACK,
  SNAP_MODEL_BUILTIN_URL,
  configureHubCache,
  fetchCodeArtsRemoteModels,
  isCodeArtsBenefitModel,
  isVisualModelId,
  parseModelInfo,
} from "../vendor/ofm/src/models.ts";

/**
 * 宿主只在 `resolveModel().context` 里读上下文窗口
 * （`dsh-llm` 的 `normalizeModelInfo`；`listModels` 的返回值**不含**该字段）。
 * 缺了它，`dsh-compaction-basic` 会在每一步抛
 * `TargetPressureConfigError: no context capacity for <provider>/<model>` ——
 * 自动压缩完全不工作。故这里逐渠道锁住「resolveModel 必须给出窗口」。
 */

/* ───────────────────────────── Gemini ───────────────────────────── */

function geminiAdapter(entries) {
  return new GeminiAdapter({
    credentialRef: "SYNTHETIC_GEMINI",
    resolveCredential: async () => ({ access_token: "synthetic" }),
    refresh: async () => {},
    fetchImpl: async () => {
      throw Error("network must not be used by this test");
    },
    catalogModels: () => entries,
    product: GEMINI,
  });
}

test("Gemini resolveModel reports the static 1M window when the directory omits it", async () => {
  // 真实目录（线上快照）只有 displayName / supportsImage / 档位后缀：
  // `inputTokenLimit` 实测并不下发，故 contextWindow 是 undefined。
  const discovered = parseGeminiCatalog(
    {
      models: {
        [GEMINI_UPSTREAM_FLASH]: { displayName: "Gemini Flash", supportsImages: true },
        [`${GEMINI_UPSTREAM_FLASH}-medium`]: {},
      },
    },
    GEMINI_UPSTREAM_FLASH,
  );
  assert.equal(discovered[0].contextWindow, undefined, "fixture must mirror the live shape");

  const adapter = geminiAdapter(discovered);
  const resolved = await adapter.resolveModel("gemini", GEMINI_UPSTREAM_FLASH);
  assert.equal(resolved.context?.contextWindow, GEMINI_CONTEXT_WINDOW);
  assert.equal(resolved.context?.contextWindow, 1_000_000);
});

test("Gemini prefers a remotely supplied window over the static table", async () => {
  const adapter = geminiAdapter([
    {
      id: GEMINI_UPSTREAM_FLASH,
      name: "Gemini Flash",
      contextWindow: 2_000_000,
      maxTokens: 64_000,
      supportsImage: true,
    },
  ]);
  const resolved = await adapter.resolveModel("gemini", GEMINI_UPSTREAM_FLASH);
  assert.equal(resolved.context?.contextWindow, 2_000_000);
});

test("Gemini does not invent a window for an unknown model id", async () => {
  const adapter = geminiAdapter([
    {
      id: "some-other-model",
      name: "Other",
      contextWindow: 0,
      maxTokens: 32_000,
      supportsImage: false,
    },
  ]);
  const resolved = await adapter.resolveModel("gemini", "unlisted-model");
  assert.equal(resolved.context, undefined);
  assert.equal(resolved.name, "unlisted-model");
});

/* ──────────────────────────── CodeArts ──────────────────────────── */

function codeartsAdapter(models) {
  return new CodeArtsAdapter({
    credentialRef: "SYNTHETIC_CODEARTS",
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchRemoteModels: async () => [...models],
    fetchImpl: async () => {
      throw Error("network must not be used by this test");
    },
  });
}

test("CodeArts keeps its verified static windows for the models it lists", async () => {
  const adapter = codeartsAdapter([
    { id: "GLM-5.2", name: "GLM-5.2" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ]);
  assert.equal(
    (await adapter.resolveModel("codearts", "GLM-5.2")).context?.contextWindow,
    202_752,
  );
  assert.equal(
    (await adapter.resolveModel("codearts", "deepseek-v4.1-flash")).context?.contextWindow,
    1_000_000,
  );
});

test("CodeArts prefers a window the upstream actually sends", async () => {
  const adapter = codeartsAdapter([
    { id: "GLM-5.2", name: "GLM-5.2", contextWindow: 400_000 },
  ]);
  assert.equal(
    (await adapter.resolveModel("codearts", "GLM-5.2")).context?.contextWindow,
    400_000,
  );
});

test("CodeArts still leaves genuinely unknown models without a window", async () => {
  // 静态表只覆盖「真实目录里出现过的模型」。目录若推来一个表外的新模型，
  // 仍然**不编造**窗口（宿主会明确告警，而不是按假窗口压坏历史）。
  const adapter = codeartsAdapter([{ id: "some-brand-new-model", name: "New" }]);
  const resolved = await adapter.resolveModel("codearts", "some-brand-new-model");
  assert.equal(resolved.context, undefined);
});

test("every model the live CodeArts directory can actually expose resolves to a window", async () => {
  // 2026-10-28：目录（`/v1/model/builtin`）实测**不下发任何窗口字段**，
  // 可见模型全靠静态表。此前的缺口（glm-5.3 / glm-5.2-sft-harmony /
  // openpangu-2.0-flash / openpangu-2.0-pro / kimi-k3）已按各自发行方的
  // 通用大小补进表。
  //
  // ⚠️ `kimi-k2.6-vl` **不在**此列：它是视觉模型，被 `isVisualModelId`
  // 过滤掉、不会出现在菜单里（见下一条测试），故不需要窗口。
  const liveVisibleIds = [
    "GLM-5.2",
    "openpangu-2.0-flash",
    "openpangu-2.0-pro",
    "glm-5.3",
    "glm-5.2-sft-harmony",
    "deepseek-v4.1-flash",
    "kimi-k3",
  ];
  const adapter = codeartsAdapter(liveVisibleIds.map((id) => ({ id, name: id })));
  const missing = [];
  for (const id of liveVisibleIds) {
    const resolved = await adapter.resolveModel("codearts", id);
    if (resolved.context?.contextWindow === undefined) missing.push(id);
  }
  assert.deepEqual(missing, [], "every visible live directory model must carry a window");
});

test("CodeArts static windows follow each model's published size, not one shared value", async () => {
  // 逐个值钉死，防止有人「顺手统一成 1M」。这些数字各有来源（见
  // `llm-adapter.ts` 的 CONTEXT_WINDOWS 注释），尤其码道自己的 GLM-5.2
  // 是 202752 而非 buddy/qoder 的 1M，口径不同不能混用。
  const expected = {
    "GLM-5.2": 202_752,
    "glm-5.3": 1_000_000,
    "glm-5.2-sft-harmony": 202_752,
    "openpangu-2.0-flash": 524_288,
    "openpangu-2.0-pro": 524_288,
    "kimi-k3": 1_000_000,
    "deepseek-v4.1-flash": 1_000_000,
  };
  const adapter = codeartsAdapter(
    Object.keys(expected).map((id) => ({ id, name: id })),
  );
  for (const [id, window] of Object.entries(expected)) {
    assert.equal(
      (await adapter.resolveModel("codearts", id)).context?.contextWindow,
      window,
      `${id} must keep its published window`,
    );
  }
});

/* ──────────────────── 视觉模型过滤判据统一 ──────────────────── */

/**
 * `isVisualModelId` 是 `parseModelInfo` 与 `listAllModels` 的**唯一**判据。
 *
 * 历史缺陷（2026-10-28 修）：两处各写一遍，`parseModelInfo` 只认大写
 * `-VL` / `-VL-`，`listAllModels` 用了 `/i`。码道目录里真实存在全小写的
 * `kimi-k2.6-vl` —— 一处放行、一处拦截，菜单虽然正确，但任何直接用
 * `parseModelInfo` 产物的调用方都会漏进小写 VL 模型。
 */
test("VL filtering is case-insensitive and shared by both call sites", () => {
  const visual = ["kimi-k2.6-vl", "kimi-k2.6-VL", "Qwen3-VL-235B", "qwen3-vl-235b", "foo-Vl"];
  for (const id of visual) assert.equal(isVisualModelId(id), true, `${id} must be visual`);
  const chat = ["glm-5.3", "GLM-5.2", "claude-sonnet", "vl-only-prefix", "model-vlr"];
  for (const id of chat) assert.equal(isVisualModelId(id), false, `${id} must not be visual`);
});

test("parseModelInfo drops a lowercase VL model instead of forwarding it", () => {
  // 真实目录里的形状：全小写 `-vl`。
  const parsed = parseModelInfo({ model_id: "kimi-k2.6-vl", model_name: "Kimi-K2.6-VL" }, new Set());
  assert.equal(parsed, undefined);
  // 大写仍照旧过滤。
  assert.equal(parseModelInfo({ model_id: "Qwen3-VL-235B", model_name: "Q" }, new Set()), undefined);
  // 非视觉模型不受影响。
  assert.deepEqual(parseModelInfo({ model_id: "glm-5.3", model_name: "GLM-5.3" }, new Set()), {
    id: "glm-5.3",
    name: "GLM-5.3",
  });
});

/* ──────────────────── 免费权益（benefit）通道已下线 ──────────────────── */

/**
 * 2026-10 上游关闭 benefit 通道后的回归锁。
 *
 * 背景：兜底集合里曾有 `glm-5.3-flash` / `deepseek-v4.1-flash`，于是每个这类
 * 请求都先带 `maas_type: benefit` 失败一次、再去掉该头重试才成功 —— 白花一次
 * 往返。真实复测（本机）：`glm-5.3` 不带该头 200 正常出流，带上则
 * `InferHub.4004.200 benefit not found`。
 */
test("CodeArts no longer marks models as benefit after the channel shutdown", () => {
  // 关键断言：这两个曾经在兜底表里的 id 现在必须是 false，否则每个请求
  // 都会多打一次必然失败的上游调用。
  assert.equal(isCodeArtsBenefitModel("glm-5.3-flash"), false);
  assert.equal(isCodeArtsBenefitModel("deepseek-v4.1-flash"), false);
  assert.equal(isCodeArtsBenefitModel("glm-5.3"), false);
  assert.equal(isCodeArtsBenefitModel("GLM-5.2"), false);
  assert.deepEqual([...CODEARTS_BENEFIT_FALLBACK], []);
});

test("CodeArts still retries once when upstream reports benefit not found", async () => {
  // 回归锁（2026-10-28）：删掉 `&& isBenefitModel` 之前，兜底表为空会让
  // `isBenefitModel` 恒 false，这个自愈分支变成**死代码** —— 真收到
  // `benefit not found` 只会把错误抛给用户。
  //
  // 注意：现在代码根本不发 `maas_type`，所以这里**不按请求头**模拟，而是让
  // 上游第一次就回 `benefit not found`（真实成因不止一种，例如账号侧缺少
  // benefit 包）。断言「自动重试一次并恢复」，而不是把错误抛给调用方。
  let calls = 0;
  const adapter = new CodeArtsAdapter({
    credentialRef: "SYNTHETIC_CODEARTS",
    resolveCredential: async () => ({
      access_key_id: "synthetic-ak",
      secret_access_key: "synthetic-sk",
      security_token: "synthetic-st",
    }),
    refresh: async () => {},
    fetchRemoteModels: async () => [{ id: "glm-5.3", name: "GLM-5.3" }],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        // HTTP 200 + SSE 内嵌业务错误（CodeArts 的真实形态）
        return new Response(
          'data: {"error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n' +
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const text = [];
  for await (const chunk of adapter.stream({
    model: "glm-5.3",
    signal: AbortSignal.timeout(10_000),
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    if (chunk.type === "text-delta" || chunk.type === "text") text.push(chunk.text ?? "");
  }
  // 关键断言一：确实重试了（两次请求），说明分支可达、不再是死代码。
  assert.equal(calls, 2, "must retry exactly once after benefit-not-found");
  // 关键断言二：最终拿到正文，而不是把错误抛给调用方。
  assert.equal(text.join(""), "OK");
});

test("CodeArts catalog stops calling the retired gateway config endpoint", async () => {
  // 只允许打 builtin 一个端点：gateway/config 已下线（恒 4000 invalid channel），
  // 每次刷新白打一次必然失败的请求。
  const requested = [];
  const models = await fetchCodeArtsRemoteModels(
    { access_key_id: "synthetic-ak", secret_access_key: "synthetic-sk", security_token: "synthetic-st" },
    async (url) => {
      requested.push(String(url));
      return new Response(
        JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: "glm-5.3", model_name: "GLM-5.3" },
            { model_id: "GLM-5.2", model_name: "GLM-5.2" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.deepEqual(requested, [SNAP_MODEL_BUILTIN_URL]);
  assert.ok(!requested.some((url) => url.includes("gateway/config")));
  assert.deepEqual(models.map((m) => m.id), ["glm-5.3", "GLM-5.2"]);
});

test("CodeArts ignores a stale on-disk benefit cache written before the shutdown", () => {
  // 用户机器上可能残留 codearts_benefit_models.json（通道关闭前写入的历史模型）。
  // 判定刻意不再读它：否则一份死数据会长期决定是否发 maas_type。
  const dir = mkdtempSync(join(tmpdir(), "chub-benefit-"));
  try {
    writeFileSync(
      join(dir, "codearts_benefit_models.json"),
      JSON.stringify(["glm-5.3-flash", "deepseek-v4.1-flash"]),
      "utf-8",
    );
    configureHubCache(dir);
    assert.equal(isCodeArtsBenefitModel("glm-5.3-flash"), false);
    assert.equal(isCodeArtsBenefitModel("deepseek-v4.1-flash"), false);
  } finally {
    configureHubCache(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CodeArts directory parsing only forwards windows the upstream declares", () => {
  const base = { model_id: "glm-5.3", model_name: "GLM-5.3" };
  assert.deepEqual(parseModelInfo(base, new Set()), {
    id: "glm-5.3",
    name: "GLM-5.3",
  });
  assert.deepEqual(
    parseModelInfo({ ...base, context_window: 1_048_576 }, new Set()),
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_048_576 },
  );
  // 非正数/非有限数一律丢弃：0 会让 DSH 抛 INVALID_MODEL_CONTEXT。
  assert.deepEqual(parseModelInfo({ ...base, max_input_tokens: 0 }, new Set()), {
    id: "glm-5.3",
    name: "GLM-5.3",
  });
  assert.deepEqual(
    parseModelInfo({ ...base, max_input_tokens: Number.NaN }, new Set()),
    { id: "glm-5.3", name: "GLM-5.3" },
  );
  // 字符串形态（配置接口常见）也认。
  assert.deepEqual(
    parseModelInfo({ ...base, contextWindow: "200000" }, new Set()),
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 200_000 },
  );
  // 输出上限同理：只透传，不补默认值。
  assert.deepEqual(
    parseModelInfo({ ...base, max_output_tokens: 65_536 }, new Set()),
    { id: "glm-5.3", name: "GLM-5.3", maxTokens: 65_536 },
  );
});
