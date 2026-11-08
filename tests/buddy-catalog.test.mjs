import test from "node:test";
import assert from "node:assert/strict";
import { fetchModels } from "../vendor/ofm/src/buddy-oauth.ts";
import { WORKBUDDY } from "../vendor/ofm/src/product.ts";

const credential = { access_token: "synthetic" };

/** 企业端点恒 500 → 插件走 /v3/config 回退路径（与个人账号实测形态一致）。 */
const fetcher = async (input) => {
  const url = String(input);
  if (url.includes("/console/enterprises/"))
    return new Response("{}", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  if (url.endsWith("/v3/config"))
    return Response.json({
      data: {
        models: [
          {
            id: "hy3",
            name: "Hy3",
            credits: "x0.00",
            maxInputTokens: 192000,
            maxOutputTokens: 64000,
          },
          {
            // 2026-11-08 实测形态：视频模型带视频 tags 与 videoGeneration 配置块，
            // 不在对话 agent 引用清单里，也不下发 credits。
            id: "kling-video-v3",
            name: "Kling-Video-V3",
            tags: ["text-to-video", "image-to-video"],
            videoGeneration: { resolutions: ["720P", "1080P"] },
          },
          {
            // buddy scoped 端点同日实测：混元图像编辑模型（image-to-image），
            // 无 credits、无 maxInputTokens —— 与文生图同族，一并滤出。
            id: "hunyuan-image-alpha-edit",
            name: "Hunyuan Image Alpha Edit",
            tags: ["image-to-image"],
          },
          {
            // 同族文生图（text-to-image），既有判据锁定。
            id: "hunyuan-image-alpha",
            name: "Hunyuan Image Alpha",
            tags: ["text-to-image"],
          },
          {
            // 既有行为锁定：图片模型同样不进对话菜单。
            id: "img-model",
            name: "Img",
            tags: ["text-to-image"],
          },
        ],
        agents: [{ name: "cli", models: ["hy3"] }],
      },
    });
  throw Error("unexpected fixture endpoint " + url);
};

test("video-generation models never enter the chat catalog", async () => {
  const models = await fetchModels(credential, fetcher, undefined, WORKBUDDY);
  assert.deepEqual(
    models.map((m) => m.id),
    ["hy3"],
  );
  assert.equal(models[0]?.creditsRate, "x0.00");
});

test("image-to-image edit models are filtered like text-to-image", async () => {
  const models = await fetchModels(credential, fetcher, undefined, WORKBUDDY);
  const ids = models.map((m) => m.id);
  assert.equal(ids.includes("hunyuan-image-alpha-edit"), false);
  assert.equal(ids.includes("hunyuan-image-alpha"), false);
  assert.equal(ids.includes("img-model"), false);
  assert.equal(ids.includes("kling-video-v3"), false);
});

test("unpriced chat-shaped models stay with an empty coefficient", async () => {
  // hy4-preview（agent 引用）与 hunyuan-chat（Hunyuan-Turbos，补齐路径）同形：
  // 上游未公布系数但**有 maxInput/maxOutput 的对话形状** —— 按政策保留、
  // 系数留空（不编默认值），锁定「无系数不等于被过滤」。
  const fetcherWithPreview = async (input) => {
    const url = String(input);
    if (url.includes("/console/enterprises/"))
      return new Response("{}", { status: 500 });
    if (url.endsWith("/v3/config"))
      return Response.json({
        data: {
          models: [
            { id: "hy4-preview", name: "Hy4 Preview", maxInputTokens: 1000000 },
            {
              id: "hunyuan-chat",
              name: "Hunyuan-Turbos",
              maxInputTokens: 200000,
              maxOutputTokens: 8192,
            },
          ],
          agents: [{ name: "cli", models: ["hy4-preview"] }],
        },
      });
    throw Error("unexpected fixture endpoint " + url);
  };
  const models = await fetchModels(
    credential,
    fetcherWithPreview,
    undefined,
    WORKBUDDY,
  );
  assert.deepEqual(models.map((m) => m.id), ["hy4-preview", "hunyuan-chat"]);
  assert.equal(models[0]?.creditsRate, undefined);
  assert.equal(models[1]?.creditsRate, undefined);
});
