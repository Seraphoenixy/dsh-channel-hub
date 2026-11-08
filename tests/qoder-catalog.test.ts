import test from "node:test";
import assert from "node:assert/strict";
import { parseQoderCatalogModels } from "../src/drivers/qoder-catalog.ts";

const entry = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key,
  display_name: name,
  enable: true,
  price_factor: 0,
  ...extra,
});

test("chat-only responses parse exactly as before", () => {
  const models = parseQoderCatalogModels({ chat: [entry("dfmodel", "DeepSeek-Flash")] });
  assert.deepEqual(
    models?.map((m) => m.id),
    ["dfmodel"],
  );
});

test("QoDuck ships in the app scene only and must be picked up", () => {
  // 2026-11-08 真实目录形态：chat 无 lmodel，app 场景才有 QoDuck。
  const models = parseQoderCatalogModels({ app: [entry("lmodel", "QoDuck")] });
  assert.deepEqual(
    models?.map((m) => m.id),
    ["lmodel"],
  );
});

test("both scenes merge by id with chat first and app extras appended", () => {
  const models = parseQoderCatalogModels({
    chat: [entry("auto", "Auto"), entry("dfmodel", "DeepSeek-Flash")],
    app: [
      entry("auto", "Auto"), // 重复 id：chat 优先，不产生第二条
      entry("dfmodel", "DeepSeek-Flash", { enable: false }), // chat 优先，不被停用版覆盖
      entry("lmodel", "QoDuck"),
    ],
  });
  assert.deepEqual(
    models?.map((m) => m.id),
    ["auto", "dfmodel", "lmodel"],
  );
  assert.equal(models?.find((m) => m.id === "dfmodel")?.name, "DeepSeek-Flash");
});

test("missing both scenes still means an unrecognizable catalog", () => {
  assert.equal(parseQoderCatalogModels({ developer: [] }), undefined);
  assert.equal(parseQoderCatalogModels("not-an-object"), undefined);
});

test("lmodel thinking tiers and context survive the merge", () => {
  // 实测条目口径：档位表最大档 1M；efforts 取 enabled.efforts 的键，默认 xhigh，
  // disabled 分支存在 = 可关闭思考。
  const models = parseQoderCatalogModels({
    app: [
      entry("lmodel", "QoDuck", {
        is_vl: true,
        is_reasoning: true,
        is_free: true,
        original_price_factor: 0.5,
        context_config: {
          "1M": { token_count: 1000000 },
          "200K": { token_count: 200000, is_default: true },
          "400K": { token_count: 400000 },
        },
        thinking_config: {
          disabled: {},
          enabled: { efforts: { xhigh: { is_default: true }, high: {}, low: {} }, is_default: true },
        },
      }),
    ],
  });
  const lmodel = models?.[0];
  assert.equal(lmodel?.contextWindow, 1_000_000);
  assert.deepEqual(lmodel?.efforts, ["xhigh", "high", "low"]);
  assert.equal(lmodel?.defaultEffort, "xhigh");
  assert.equal(lmodel?.supportsDisable, true);
  assert.equal(lmodel?.supportsImage, true);
  assert.equal(lmodel?.isFree, true);
  assert.equal(lmodel?.priceFactor, 0);
});
