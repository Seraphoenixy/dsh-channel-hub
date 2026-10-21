import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
let host;
try {
  host = await import("@deepseek-ai/cordis");
} catch {}

/**
 * Gemini 工具调用的签名链路（真实宿主 + 模拟上游，不联网、不读真实账号）。
 *
 * 真实缺陷（2026-10-21，用户报障）：Gemini 回 400
 * `Function call is missing a thought_signature in functionCall parts ...
 *  function call default_api:grep, position 6`。
 *
 * 根因是**驱动层从未构造签名缓存**（`src/drivers/ofm.js` 的 adapter options 里
 * 没有 `sigStore`）⇒ 上游下发的签名没人接收、下一轮也没人回填。
 *
 * 本测试走真实的 `prepareCall → adapter.stream → SSE` 路径，断言：
 * 1. 上游在 **thought part** 上给的签名被接收并落盘（`gemini-sigs.json`）；
 * 2. 下一轮请求把该签名回填到 `functionCall` 上（而不是发哨兵）。
 */
test(
  "actual host captures a Gemini thought signature and replays it on the next tool turn",
  { skip: !host },
  async () => {
    const { Context, Service } = host;
    const { LlmRuntime, createUserMessage, createAssistantMessage, createToolResultMessage } =
      await import("@deepseek-ai/dsh-llm");
    const { credentialRef } = await import("@deepseek-ai/dsh-credentials");
    const dir = mkdtempSync(join(tmpdir(), "chub-gemini-sig-"));
    const data = join(dir, "profiles", "desktop", "channel-hub");
    const namespace =
      "CHANNEL_HUB_" +
      createHash("sha256").update(data).digest("hex").slice(0, 12) +
      "_";
    mkdirSync(join(data, "channel-pack"), { recursive: true });
    writeFileSync(
      join(data, "channel-pack", "state.json"),
      JSON.stringify({
        accounts: [
          {
            id: "gemini-sig",
            provider: "gemini",
            nickname: "Google",
            credentialRef: "GEMINI_SIG",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
        ],
        disabledModels: {},
      }),
    );
    const values = new Map([
      [
        namespace + "GEMINI_SIG",
        JSON.stringify({
          access_token: "synthetic-google",
          expiry: new Date(Date.now() + 3600000).toISOString(),
          // 项目号直接给凭据里的值：跳过 `loadCodeAssist` 探测（与本缺陷无关）。
          cloudaicompanionProject: "synthetic-project",
        }),
      ],
    ]);
    const ctx = new Context();
    class Credentials extends Service {
      constructor(c) {
        super(c, "credentials");
      }
      async resolve(ref) {
        credentialRef(ref);
        const value = values.get(ref);
        return value ? { value } : undefined;
      }
      async set(ref, value) {
        credentialRef(ref);
        values.set(ref, value);
      }
    }
    new Credentials(ctx);
    const llm = new LlmRuntime(ctx);
    const previous = process.env.DSH_HOME;
    const fetchBefore = globalThis.fetch;
    process.env.DSH_HOME = dir;

    /** 每次推理请求的 wire 体（用于断言签名回填）。 */
    const inferenceBodies = [];

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("fetchAvailableModels"))
        return Response.json({
          models: { "gemini-3.8-flash-medium": { displayName: "Gemini Flash" } },
        });
      if (url.includes("streamGenerateContent") || url.includes("generateContent")) {
        inferenceBodies.push(JSON.parse(String(init?.body ?? "{}")));
        // 第一轮：模型先思考（签名挂在 **thought part** 上），然后调用工具。
        const frames =
          inferenceBodies.length === 1
            ? [
                {
                  response: {
                    candidates: [
                      {
                        content: {
                          role: "model",
                          parts: [
                            {
                              thought: true,
                              text: "I should search the repository.",
                              thoughtSignature: "THOUGHT-SIG-1",
                            },
                            {
                              functionCall: {
                                name: "default_api:grep",
                                args: { pattern: "needle" },
                              },
                            },
                          ],
                        },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
                  },
                },
              ]
            : [
                {
                  response: {
                    candidates: [
                      {
                        content: {
                          role: "model",
                          parts: [{ text: "found it" }],
                        },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 },
                  },
                },
              ];
        return new Response(
          frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      throw Error("Unexpected fixture endpoint " + url);
    };

    let plugin;
    try {
      plugin = await (await import("../dist/index.js")).apply(ctx);
      await plugin.dispatch("models.refresh", { provider: "gemini" });
      const provider = "channel-hub/gemini";

      // —— 第 1 轮：模型思考并调用工具 ——
      const first = await llm.prepareCall({ provider, model: "gemini-3.8-flash" });
      const firstChunks = [];
      for await (const chunk of first.stream({
        ...first.config,
        messages: [createUserMessage({ content: [{ type: "text", text: "find needle" }] })],
        tools: [
          {
            name: "default_api:grep",
            description: "Search text",
            parameters: { type: "object", properties: { pattern: { type: "string" } } },
          },
        ],
      }))
        firstChunks.push(chunk);

      const toolCall = firstChunks.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
      assert.ok(toolCall, JSON.stringify(firstChunks));
      assert.equal(toolCall.block.name, "default_api:grep");

      // 签名必须已落盘到 channel-pack 目录（与 state.json 同目录）。
      const sigFile = join(data, "channel-pack", "gemini-sigs.json");
      assert.ok(existsSync(sigFile), "the captured signature must be persisted");
      assert.match(readFileSync(sigFile, "utf8"), /THOUGHT-SIG-1/);

      // —— 第 2 轮：把工具结果回填，同一轮的下一次请求 ——
      const second = await llm.prepareCall({ provider, model: "gemini-3.8-flash" });
      const secondChunks = [];
      for await (const chunk of second.stream({
        ...second.config,
        messages: [
          createUserMessage({ content: [{ type: "text", text: "find needle" }] }),
          // ⚠️ 用构造器生成，不手写对象：DSH 的 assistant 消息带 `source`
          // （含 replayState 走向），手写会让 `forAdapter` 读 `source` 时崩。
          createAssistantMessage({
            content: [
              {
                type: "tool-call",
                id: toolCall.block.id,
                name: "default_api:grep",
                arguments: '{"pattern":"needle"}',
              },
            ],
          }),
          createToolResultMessage({
            // ⚠️ 参数名是 `callId`（不是 `toolCallId`）：构造器会把 `callId`
            // 同时写进顶层 `toolCallId` 与 `source.callId`，配对照这两处识别。
            callId: toolCall.block.id,
            content: [{ type: "text", text: "needle at line 3" }],
          }),
        ],
        tools: [
          {
            name: "default_api:grep",
            description: "Search text",
            parameters: { type: "object", properties: { pattern: { type: "string" } } },
          },
        ],
      }))
        secondChunks.push(chunk);

      assert.ok(
        secondChunks.some((c) => c.type === "text-delta" && c.text === "found it"),
        JSON.stringify(secondChunks),
      );

      // 第二轮请求里，那个 functionCall 必须带上**真签名**，而不是哨兵。
      assert.equal(inferenceBodies.length, 2);
      const contents = inferenceBodies[1].request.contents;
      const replay = contents
        .flatMap((c) => c.parts ?? [])
        .find((p) => p.functionCall?.name === "default_api:grep");
      assert.ok(replay, JSON.stringify(contents));
      assert.equal(
        replay.thoughtSignature,
        "THOUGHT-SIG-1",
        "the captured signature must be replayed instead of the skip sentinel",
      );
    } finally {
      await plugin?.stop();
      globalThis.fetch = fetchBefore;
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      await ctx.stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
