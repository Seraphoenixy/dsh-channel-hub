import test from "node:test";
import assert from "node:assert/strict";
import { GeminiAdapter } from "../vendor/ofm/src/gemini-adapter.ts";
import { GEMINI, GEMINI_CONTEXT_WINDOW, GEMINI_UPSTREAM_FLASH } from "../vendor/ofm/src/gemini.ts";
import { parseGeminiCatalog } from "../src/drivers/gemini-catalog.ts";
import { CodeArtsAdapter } from "../vendor/ofm/src/llm-adapter.ts";
import { parseModelInfo } from "../vendor/ofm/src/models.ts";

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

test("CodeArts leaves unknown models without a window instead of guessing", async () => {
  const adapter = codeartsAdapter([{ id: "openpangu-2.0-flash", name: "OpenPangu" }]);
  const resolved = await adapter.resolveModel("codearts", "openpangu-2.0-flash");
  // 静态表没有这条 —— 宁可不声明（宿主会明确告警），也不编一个窗口。
  assert.equal(resolved.context, undefined);
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
