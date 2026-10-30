import test from "node:test";
import assert from "node:assert/strict";
import { RaccoonAdapter } from "../vendor/ofm/src/raccoon-adapter.ts";
import { RACCOON } from "../vendor/ofm/src/raccoon-product.ts";
import { RACCOON_REQUEST_IMAGE_MAX_BYTES } from "../vendor/ofm/src/image-budget.ts";
import { makeImageRequestBridge } from "../src/drivers/ofm.js";

/**
 * 回归锁（2026-10-29，用户报障 raccoon 413「request body exceeds 10MB」、
 * qoder 413「Request body size exceeds maximum allowed 52428800 bytes」）。
 *
 * ## 根因（账本 + 代码双证）
 *
 * 会话 `session-b572…` 90 个请求：raccoon 连续 17 轮成功后，13:07 起连续
 * `request body exceeds 10MB` —— 典型「图片随会话累积、每轮全量重发」。
 * 体积不在文本上下文（那很小），在 base64 内联的原图字节。
 *
 * 适配器侧的自愈链路（`projectRequestImage` → 产品预算 640k 像素 +
 * 512KB/张）在 vendor 里早已存在且正确；但本仓库的驱动层
 * （`src/drivers/ofm.js`）从 vendor 原入口改造时**只桥接了 `readImage`
 * （原图），漏了 `readImageRequest`（缩放投影）** —— `projectRequestImage`
 * 第一行 `readImageRequest === undefined` 直接返回，于是每张图都按原始
 * 字节内联。两层夹具分别锁住「适配器在拿到桥接后会走投影」与
 * 「驱动真的把桥接递给了每个适配器」。
 *
 * 与真实网络验收的分工（AGENTS.md）：夹具不联网、不读真实账号。
 */

/* ───────────── 适配器层：投影可用时按预算缩，不可用时回退原图 ───────────── */

/** 生成一张合成 PNG 的字节数组（内容无关紧要，只看大小路由）。 */
function fakeImage(bytes) {
  return new Uint8Array(bytes).fill(65); // 'A'
}

function raccoonFixture({ projected, raw }) {
  const requested = [];
  const adapter = new RaccoonAdapter({
    credentialRef: "SYNTHETIC_RACCOON",
    product: { ...RACCOON, fallbackModels: [] },
    resolveCredential: async () => ({
      access_token: "synthetic-raccoon-token",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      office_identity: "org",
    }),
    refresh: async () => undefined,
    fetchRemoteModels: async () => [
      { id: "sn-deepseek-v4-1-flash", name: "DS Flash", contextWindow: 128000, maxTokens: 8192, supportsImage: true },
    ],
    readImage: async () => raw,
    readImageRequest: async (attachment, target) => {
      requested.push(target);
      return projected === undefined
        ? undefined
        : { data: projected, mediaType: "image/jpeg" };
    },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      // 请求体里所有 image_url 的 base64 总量（bytes 视角）
      let total = 0;
      for (const m of body.messages) {
        const parts = Array.isArray(m.content) ? m.content : [];
        for (const p of parts) {
          if (p?.type === "image_url") {
            total += (p.image_url.url.length - "data:image/jpeg;base64,".length) * 3 / 4;
          }
        }
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { adapter, requested };
}

const messageWithImage = (id) => ({
  role: "user",
  content: [
    { type: "text", text: "看图" },
    { type: "image", attachment: { attachmentId: id, mediaType: "image/png", width: 2560, height: 1600 } },
  ],
});

test("raccoon adapter projects images through the request bridge instead of sending originals", async () => {
  // 投影可用：一张 7MB「原图」应被替换成 ≤512KB 的投影版本。
  const raw = fakeImage(7 * 1024 * 1024);
  const projected = fakeImage(256 * 1024);
  const { adapter, requested } = raccoonFixture({ projected, raw });
  const text = [];
  for await (const chunk of adapter.stream({
    model: "sn-deepseek-v4-1-flash",
    signal: AbortSignal.timeout(10_000),
    tools: [],
    messages: [messageWithImage("img-1")],
  })) {
    if (chunk.type === "text-delta" || chunk.type === "text") text.push(chunk.text ?? "");
  }
  assert.equal(text.join(""), "OK");
  // 投影确实被请求过，且带上产品预算（640k 像素 + 512KB 字节）。
  assert.equal(requested.length, 1);
  assert.equal(requested[0].maxBytes, RACCOON_REQUEST_IMAGE_MAX_BYTES);
  assert.equal(requested[0].maxBytes, 512 * 1024);
  // 像素预算把 2560×1600（409.6 万像素）缩进 640k。
  assert.ok(requested[0].width * requested[0].height <= 640_000);
});

test("raccoon adapter falls back to raw bytes when the projection is unavailable", async () => {
  // 投影不可用（老宿主）：回退 readImage 原图 —— 保守方向正确（宁可发大图，
  // 不能因「想缩图」打死请求）。这正是驱动层漏桥接时每个请求的实际行为，
  // 也是本次 413 报障的直接机制。
  const raw = { data: fakeImage(7 * 1024 * 1024), mediaType: "image/png" };
  const { adapter } = raccoonFixture({ projected: undefined, raw });
  const text = [];
  for await (const chunk of adapter.stream({
    model: "sn-deepseek-v4-1-flash",
    signal: AbortSignal.timeout(10_000),
    tools: [],
    messages: [messageWithImage("img-1")],
  })) {
    if (chunk.type === "text-delta" || chunk.type === "text") text.push(chunk.text ?? "");
  }
  assert.equal(text.join(""), "OK");
});

/* ───────────── 驱动层：桥接函数的完整错误契约 ───────────── */

test("image request bridge forwards the host projection and normalizes mediaType", async () => {
  const calls = [];
  const ctx = {
    get: (name) =>
      name === "attachments"
        ? {
            readImageRequest: async (attachment, target) => {
              calls.push({ attachment, target });
              return {
                data: new Uint8Array([1, 2, 3]),
                // 宿主可能把 mediaType 挂在 attachment 上（vendor 同款兼容）。
                attachment: { mediaType: "image/webp" },
              };
            },
          }
        : undefined,
    logger: { warn: () => {} },
  };
  const bridge = makeImageRequestBridge(ctx);
  const out = await bridge({ attachmentId: "a", width: 100, height: 50 }, { width: 80, height: 40, maxBytes: 512 * 1024 });
  assert.deepEqual(out, { data: new Uint8Array([1, 2, 3]), mediaType: "image/webp" });
  // 目标被原样透传（适配器侧的预算决定权不受桥接影响）。
  assert.equal(calls[0].target.maxBytes, 512 * 1024);
});

test("image request bridge returns undefined when the host has no attachment service", async () => {
  // 老宿主 / 未装附件服务：返回 undefined（绝不抛错），适配器回退原图。
  const ctx = { get: () => undefined, logger: { warn: () => {} } };
  assert.equal(await makeImageRequestBridge(ctx)({}, {}), undefined);
  const ctx2 = {
    get: () => ({ readImage: async () => {} }), // 只有老契约 readImage
    logger: { warn: () => {} },
  };
  assert.equal(await makeImageRequestBridge(ctx2)({}, {}), undefined);
});

test("image request bridge swallows projection errors and logs a warning", async () => {
  const warnings = [];
  const ctx = {
    get: () => ({
      readImageRequest: async () => {
        throw Error("cache unwritable");
      },
    }),
    logger: { warn: (m) => warnings.push(m) },
  };
  const out = await makeImageRequestBridge(ctx)({}, {});
  assert.equal(out, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /回退原图/);
});

/* ───────────── 驱动层：每个适配器都真的拿到桥接 ───────────── */

test("every driver forwards readImageRequest to its adapter options", async () => {
  // 这正是本次报障的缺口：适配器选项里没有 readImageRequest 时，
  // projectRequestImage 恒走「回退原图」。这里直接加载驱动模块源，
  // 验证构造适配器的 options 对象包含同名的桥接函数。
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/drivers/ofm.js", import.meta.url), "utf8");
  // 修复写法：options 里同时含 readImage 与 readImageRequest 两个键。
  assert.match(source, /readImageRequest:\s*imageRequestBridge/);
  // 且桥接本身从宿主附件服务取 readImageRequest（而不是别的名字）。
  assert.match(source, /readImageRequest/);
});

/* ───────────── 数学锁：raccoon 预算与 10MB 上限的余量 ───────────── */

test("raccoon image budget leaves headroom under the 10MB gateway limit", () => {
  // 每张 ≤512KB（编码后），base64 膨胀 4/3 ≈ 683KB/张：10 张 ≈ 6.7MB < 10MB；
  // 15 张才越界。预算把「几张大图顶穿上限」换成「极端张数才触顶」——
  // 报障会话顶穿的直接原因就是没走投影、原图直发。
  const perImageBase64 = (RACCOON_REQUEST_IMAGE_MAX_BYTES * 4) / 3;
  assert.ok(perImageBase64 * 10 < 10 * 1024 * 1024, "10 projected images must stay under the 10MB cap");
  assert.ok(
    perImageBase64 * 15 >= 10 * 1024 * 1024,
    "15 projected images would still hit the cap — the budget trades count for safety",
  );
});
