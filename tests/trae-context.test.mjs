import test from "node:test";
import assert from "node:assert/strict";
import {
  contextTier,
  extendedTierBadge,
  extendedTierLabel,
  baseContextLabel,
  tokenText,
} from "../src/core/context.ts";
import { TraeAdapter } from "../vendor/ofm/src/trae-adapter.ts";
import { traeMaxModeFields } from "../vendor/ofm/src/trae.ts";
import { TRAE } from "../vendor/ofm/src/trae-product.ts";

/* ────────────────────────── 展示层：tokenText / 档位 ────────────────────────── */

test("tokenText only abbreviates exact multiples so precise windows stay precise", () => {
  assert.equal(tokenText(1_000_000), "1M");
  assert.equal(tokenText(1_048_576), "1M");
  assert.equal(tokenText(200_000), "200K");
  assert.equal(tokenText(262_144), "256K");
  // 202752 = 198 × 1024：整除，故「198K」是精确值（不是四舍五入）。
  assert.equal(tokenText(202_752), "198K");
  assert.equal(tokenText(116_000), "116K");
  // 真正除不尽的值原样给出，绝不四舍五入成整数档。
  assert.equal(tokenText(202_753), "202753");
  assert.equal(tokenText(981_504), "981504");
  assert.equal(tokenText(0), undefined);
  assert.equal(tokenText(-1), undefined);
  assert.equal(tokenText(Number.NaN), undefined);
  assert.equal(tokenText("1M"), undefined);
});

test("contextTier treats an equal max window as one tier, not two", () => {
  // 实测 Doubao-Seed-2.1-Turbo：context_window_tokens 的 dev 与 max 都是 256K。
  assert.deepEqual(contextTier({ contextWindow: 256_000, maxContextWindow: 256_000 }), {
    base: 256_000,
  });
  assert.deepEqual(contextTier({ contextWindow: 200_000, maxContextWindow: 1_000_000 }), {
    base: 200_000,
    extended: 1_000_000,
  });
  // 只有 max 没有 base：仍是「另一档」，不能丢。
  assert.deepEqual(contextTier({ maxContextWindow: 1_000_000 }), {
    extended: 1_000_000,
  });
  assert.equal(contextTier({}), undefined);
  assert.equal(contextTier(undefined), undefined);
  assert.equal(contextTier({ contextWindow: 0 }), undefined);
});

test("extendedTierLabel never claims a tier the model does not have", () => {
  const maxModel = { contextWindow: 200_000, maxContextWindow: 1_000_000 };
  assert.equal(extendedTierLabel(maxModel, true), "1M");
  assert.equal(extendedTierLabel(maxModel, false), undefined);
  // 只有一档的模型即使开关打开也不加后缀。
  assert.equal(
    extendedTierLabel({ contextWindow: 256_000, maxContextWindow: 256_000 }, true),
    undefined,
  );
  assert.equal(extendedTierLabel({ contextWindow: 200_000 }, true), undefined);
  assert.equal(baseContextLabel({ contextWindow: 200_000 }), "200K");
  assert.equal(baseContextLabel({}), undefined);
});

test("extendedTierBadge separates capability from the current switch", () => {
  const model = { contextWindow: 200_000, maxContextWindow: 1_000_000 };
  const off = extendedTierBadge(model, false);
  assert.equal(off?.label, "1M");
  assert.equal(off?.active, false);
  assert.match(String(off?.title), /未启用/);
  assert.match(String(off?.title), /计费倍率/);
  const on = extendedTierBadge(model, true);
  assert.equal(on?.active, true);
  assert.match(String(on?.title), /当前使用 1M 档/);
  assert.equal(extendedTierBadge({ contextWindow: 200_000 }, true), undefined);
});

/* ───────────────────── 请求层：Max 档只在远端声明窗口时启用 ───────────────────── */

/** 用一份合成目录构造适配器，只测 `resolveModel` / 请求体，不发网络请求。 */
function adapterWith(models, maxMode) {
  const product = { ...TRAE, fallbackModels: [], maxMode, maxModeModels: undefined };
  const adapter = new TraeAdapter({
    credentialRef: "SYNTHETIC_TRAE",
    resolveCredential: async () => ({
      access_token: "synthetic",
      machine_id: "m",
      device_id: "d",
    }),
    refresh: async () => {},
    fetchRemoteModels: async () => models,
    fetchImpl: async () => {
      throw Error("network must not be used by this test");
    },
    product,
  });
  return { adapter, product };
}

const MODEL_WITH_MAX = {
  id: "max-model",
  name: "Max Model",
  function: "solo_agent",
  maxMode: true,
  maxContextWindow: 1_000_000,
  contextWindow: 200_000,
  maxModeOutputTokens: 64_000,
  maxOutputTokens: 32_000,
};

/** 实测形状：`max_mode: true` 但**没有** `context_window_tokens.max`（kimi-k2.6）。 */
const MODEL_MAX_WITHOUT_WINDOW = {
  id: "max-no-window",
  name: "Max Without Window",
  function: "solo_agent",
  maxMode: true,
  contextWindow: 116_000,
  maxOutputTokens: 16_000,
};

test("Trae declares the extended window only when the remote sends one", async () => {
  const { adapter } = adapterWith([MODEL_WITH_MAX], true);
  const resolved = await adapter.resolveModel("trae", "max-model");
  assert.equal(resolved.context?.contextWindow, 1_000_000);
});

test("Trae refuses Max mode when the remote flags it without a window", async () => {
  // 旧实现会落到 `?? TRAE_MAX_CONTEXT_TOKENS`，替上游编造 1M —— 这里锁住修正。
  const { adapter } = adapterWith([MODEL_MAX_WITHOUT_WINDOW], true);
  const resolved = await adapter.resolveModel("trae", "max-no-window");
  assert.equal(resolved.context?.contextWindow, 116_000);
  assert.equal(adapter.maxTierFor("max-no-window"), undefined);
});

test("Trae falls back to the regular window when the extended tier is switched off", async () => {
  const { adapter } = adapterWith([MODEL_WITH_MAX], false);
  const resolved = await adapter.resolveModel("trae", "max-model");
  assert.equal(resolved.context?.contextWindow, 200_000);
  // 能力仍在：开关关掉不影响「这个模型支持 1M」这个事实。
  assert.deepEqual(adapter.maxTierFor("max-model"), { contextWindow: 1_000_000 });
  assert.equal(adapter.maxModeEnabled, false);
});

test("Trae maxTierFor ignores a window that is not actually larger", () => {
  const { adapter } = adapterWith(
    [
      {
        id: "equal",
        name: "Equal",
        maxMode: true,
        contextWindow: 256_000,
        maxContextWindow: 256_000,
      },
    ],
    true,
  );
  return adapter.resolveModel("trae", "equal").then(() => {
    assert.equal(adapter.maxTierFor("equal"), undefined);
  });
});

test("traeMaxModeFields refuses to invent a context window", () => {
  assert.equal(traeMaxModeFields(0), undefined);
  assert.equal(traeMaxModeFields(Number.NaN), undefined);
  assert.equal(traeMaxModeFields(-1), undefined);
  const fields = traeMaxModeFields(1_000_000, 64_000);
  assert.equal(fields?.context_window_size, 1_000_000);
  assert.equal(fields?.max_tokens, 64_000);
  // 未给输出上限时用 Max 档的实测常量，而不是常规档的安全线。
  assert.equal(traeMaxModeFields(1_000_000)?.max_tokens, 64_000);
});

test("Trae product defaults Max mode to off", () => {
  // 默认值来自 `DSH_TRAE_MAX_MODE`（本测试进程未设置）—— 必须为关。
  assert.equal(TRAE.maxMode, false);
});

test("runtime toggle switches the adapter without rebuilding it", async () => {
  const { adapter } = adapterWith([MODEL_WITH_MAX], false);
  assert.equal(adapter.maxModeEnabled, false);
  adapter.setMaxModeEnabled(true);
  assert.equal(adapter.maxModeEnabled, true);
  assert.equal(
    (await adapter.resolveModel("trae", "max-model")).context?.contextWindow,
    1_000_000,
  );
  adapter.setMaxModeEnabled(false);
  assert.equal(
    (await adapter.resolveModel("trae", "max-model")).context?.contextWindow,
    200_000,
  );
});
