import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
let host;
try {
  host = await import("@deepseek-ai/cordis");
} catch {}
test(
  "actual installed host: plugin lifecycle and channel registration",
  {
    skip: !host
      ? "Host libraries unavailable; run node scripts/extract-host.mjs"
      : false,
  },
  async () => {
    const { Context, Service } = host;
    const { LlmRuntime } = await import("@deepseek-ai/dsh-llm");
    const { credentialRef } = await import("@deepseek-ai/dsh-credentials");
    const ctx = new Context();
    const records = new Map();
    class Credentials extends Service {
      constructor(ctx) {
        super(ctx, "credentials");
      }
      async resolve(ref) {
        credentialRef(ref);
        const value = records.get(ref);
        return value === undefined ? undefined : { value, source: "test" };
      }
      async set(ref, value) {
        credentialRef(ref);
        records.set(ref, value);
      }
      async delete(ref) {
        records.delete(ref);
      }
    }
    new Credentials(ctx);
    new LlmRuntime(ctx);
    const dir = mkdtempSync(join(tmpdir(), "chub-host-"));
    const data = join(dir, "profiles", "desktop", "channel-hub");
    mkdirSync(join(data, "channel-pack"), { recursive: true });
    writeFileSync(
      join(data, "channel-pack", "state.json"),
      JSON.stringify({
        accounts: [
          {
            id: "buddy-1",
            provider: "buddy",
            nickname: "Buddy One",
            credentialRef: "BUDDY_1",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
          {
            id: "buddy-2",
            provider: "buddy",
            nickname: "Buddy Two",
            credentialRef: "BUDDY_2",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
        ],
        disabledModels: {},
      }),
    );
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("Network forbidden in host contract test");
    };
    let plugin;
    try {
      const { apply } = await import("../dist/index.js");
      plugin = await apply(ctx);
      const channels = await plugin.dispatch("channels.list");
      const errors = channels.filter((c) => c.error);
      assert.deepEqual(errors, []);
      assert.equal(channels.length, 10);
      assert.equal(
        channels.some((c) => c.id === "workbuddy-cn"),
        false,
        "CodeBuddy CN / WorkBuddy CN must be one channel",
      );
      const trae = channels.find((c) => c.id === "trae");
      assert.equal(
        trae?.name,
        "Trae CN IDE",
        "the single Trae channel uses the current CN IDE identity",
      );
      assert.equal(
        trae?.canLogin,
        true,
        "Trae CN IDE must expose its native callback login",
      );
      assert.equal(
        channels.some((c) => c.id === "trae-cn" || c.id === "trae-solo"),
        false,
        "no legacy Trae SOLO or duplicate CN channel may remain",
      );
      const buddy = channels.find((c) => c.id === "buddy");
      assert.deepEqual(
        buddy.accounts.map((a) => a.id),
        ["buddy-1", "buddy-2"],
        "CodeBuddy accounts stay on the merged channel",
      );
      await plugin.dispatch("accounts.reorder", {
        provider: "buddy",
        ids: ["buddy-2", "buddy-1"],
      });
      const reordered = (await plugin.dispatch("channels.list")).find(
        (c) => c.id === "buddy",
      );
      assert.deepEqual(
        reordered.accounts.map((a) => a.id),
        ["buddy-2", "buddy-1"],
        "manual account order must persist for the shared channel",
      );
      const stats = await plugin.dispatch("usage.summary");
      assert.equal(stats.totals.requests, 0);
      assert.deepEqual(await plugin.dispatch("requests.list"), {
        total: 0,
        steps: 0,
        page: 1,
        limit: 30,
        items: [],
      });
      assert.deepEqual(await plugin.dispatch("migration.preview"), []);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
      await ctx.stop?.();
    }
  },
);

test(
  "actual host prepareCall -> Qoder WASM -> stream -> persistent request",
  { skip: !host },
  async () => {
    const { Context, Service } = host;
    const { LlmRuntime, createUserMessage } = await import(
      "@deepseek-ai/dsh-llm"
    );
    const { credentialRef } = await import("@deepseek-ai/dsh-credentials");
    const dir = mkdtempSync(join(tmpdir(), "chub-chain-"));
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
            id: "test-account",
            provider: "qodercn",
            nickname: "Test",
            credentialRef: "TEST_CREDENTIAL",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
          {
            id: "gemini-test",
            provider: "gemini",
            nickname: "Google",
            credentialRef: "GEMINI_TEST",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
          {
            id: "workbuddy-test",
            provider: "workbuddy",
            nickname: "WorkBuddy",
            credentialRef: "WORKBUDDY_TEST",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
          {
            id: "workbuddy-fail",
            provider: "workbuddy",
            nickname: "WorkBuddy Broken",
            credentialRef: "WORKBUDDY_FAIL",
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
        namespace + "TEST_CREDENTIAL",
        JSON.stringify({
          uid: "123456",
          machine_id: "00000000-0000-4000-8000-000000000000",
          access_token: "synthetic-token",
          security_oauth_token: "synthetic-token",
          expire_time: Date.now() + 3600000,
        }),
      ],
    ]);
    values.set(
      namespace + "GEMINI_TEST",
      JSON.stringify({
        access_token: "synthetic-google",
        expiry: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    values.set(
      namespace + "WORKBUDDY_TEST",
      JSON.stringify({
        access_token: "synthetic-workbuddy",
        refresh_token: "synthetic-workbuddy-refresh",
        expires_at: String(Date.now() + 3600000),
        domain: "www.workbuddy.ai",
        nickname: "WorkBuddy",
      }),
    );
    values.set(
      namespace + "WORKBUDDY_FAIL",
      JSON.stringify({
        access_token: "synthetic-workbuddy-fail",
        refresh_token: "synthetic-workbuddy-fail-refresh",
        expires_at: String(Date.now() + 3600000),
        domain: "www.workbuddy.ai",
        nickname: "WorkBuddy Broken",
      }),
    );
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
    const previous = process.env.DSH_HOME,
      fetchBefore = globalThis.fetch;
    process.env.DSH_HOME = dir;
    let inference = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (url.endsWith("/console/enterprises/personal/models"))
        return new Response("{}", {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/v3/config")) {
        if (headers.get("authorization")?.includes("synthetic-workbuddy-fail"))
          return new Response("{}", {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        return Response.json({
          data: {
            models: [{ id: "gpt-5.5", name: "GPT-5.5", credits: "x0.29" }],
            agents: [{ name: "craft", models: ["gpt-5.5"] }],
            modelPromotions: [
              {
                enabled: true,
                priority: 100,
                discount: { discountedCredits: "0x", factor: 0 },
                badge: { label: "限时免费" },
                // 只给有效期、不给每日时段：判据与时段无关，夹具因此可重复。
                schedule: { validUntil: "2099-01-01T00:00:00Z" },
                modelIds: ["gpt-5.5"],
              },
            ],
          },
        });
      }
      if (url.includes("fetchAvailableModels"))
        return Response.json({
          models: { "gemini-3.8-flash": { displayName: "Dynamic Gemini" } },
        });
      if (url.includes("/model/list"))
        return Response.json({
          chat: [
            {
              key: "dfmodel",
              display_name: "Dynamic Free",
              enable: true,
              price_factor: 0,
              is_free: true,
              context_config: { large: { token_count: 1000000 } },
            },
          ],
        });
      if (url.includes("agent_chat_generation")) {
        inference++;
        const frames = [
          { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 0 },
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
      await plugin.dispatch("models.refresh", { provider: "qodercn" });
      await plugin.dispatch("models.refresh", { provider: "gemini" });
      const workbuddySnapshots = await plugin.dispatch("models.refresh", {
        provider: "workbuddy",
      });
      assert.equal(
        workbuddySnapshots.filter((s) => s.error).length,
        1,
        "a real catalog failure must still be reported per account",
      );
      assert.match(
        String(workbuddySnapshots.find((s) => s.error)?.error),
        /目录 HTTP 500/,
      );
      const workbuddy = await llm.listModels("channel-hub/workbuddy");
      assert.deepEqual(
        workbuddy.map((m) => m.id),
        ["gpt-5.5"],
        "an optional console 500 must not discard the /v3/config models",
      );
      assert.equal(
        workbuddy[0].name,
        "GPT-5.5 · x0.29→免费",
        "the DSH model menu must keep the upstream billing coefficient",
      );
      const snapshot = (
        await plugin.dispatch("channels.list")
      ).find((c) => c.id === "workbuddy").accounts[0].catalog.models[0];
      assert.equal(
        snapshot.promotion?.label,
        "限时免费",
        "the UI needs the promotion window, not just the discounted price",
      );
      assert.equal(snapshot.promotion?.rate, "免费");
      await plugin.dispatch("models.setDisabled", {
        provider: "workbuddy",
        models: ["gpt-5.5"],
        disabled: true,
      });
      assert.deepEqual(
        await llm.listModels("channel-hub/workbuddy"),
        [],
        "bulk disable must hide the current directory in one write",
      );
      await assert.rejects(
        () =>
          plugin.dispatch("models.setDisabled", {
            provider: "workbuddy",
            all: true,
            disabled: true,
          }),
        /all is only valid when enabling models/,
        "bulk disable must name real ids instead of writing unknown ones",
      );
      await plugin.dispatch("models.setDisabled", {
        provider: "workbuddy",
        all: true,
        disabled: false,
      });
      assert.deepEqual(
        (await llm.listModels("channel-hub/workbuddy")).map((m) => m.id),
        ["gpt-5.5"],
        "bulk enable must clear the provider blacklist",
      );
      const google = await llm.listModels("channel-hub/gemini");
      assert.equal(google.length, 1);
      assert.equal(google[0].name, "Dynamic Gemini");
      const catalog = await llm.listModels("channel-hub/qodercn");
      assert.equal(catalog.length, 1);
      assert.match(catalog[0].name, /0×/);
      const prepared = await llm.prepareCall({
        provider: "channel-hub/qodercn",
        model: "dfmodel",
      });
      const chunks = [];
      for await (const chunk of prepared.stream({
        ...prepared.config,
        messages: [
          createUserMessage({ content: [{ type: "text", text: "hello" }] }),
        ],
        tools: [],
      }))
        chunks.push(chunk);
      assert.ok(
        chunks.some((c) => c.type === "text-delta" && c.text === "hello"),
        JSON.stringify(chunks),
      );
      assert.equal(inference, 1);
      const records = await plugin.dispatch("requests.list");
      assert.equal(records.total, 1);
      assert.equal(records.items[0].outcome, "success");
      assert.equal(records.items[0].attempts[0].accountId, "test-account");
      assert.equal(
        (await plugin.dispatch("usage.summary")).totals.totalTokens,
        12,
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

test(
  "Cordis plugin fiber accepts async apply result and disposes routes",
  { skip: !host },
  async () => {
    const { Context, Service } = host;
    const { LlmRuntime } = await import("@deepseek-ai/dsh-llm");
    const ctx = new Context();
    class Credentials extends Service {
      constructor(c) {
        super(c, "credentials");
      }
      async resolve() {
        return undefined;
      }
      async set() {}
    }
    new Credentials(ctx);
    const llm = new LlmRuntime(ctx);
    const previous = process.env.DSH_HOME;
    const dir = mkdtempSync(join(tmpdir(), "chub-fiber-"));
    process.env.DSH_HOME = dir;
    let fiber;
    try {
      fiber = ctx.plugin(await import("../dist/index.js"));
      while (fiber.inertia) await fiber.inertia;
      assert.equal(fiber.state, 2, String(fiber._error));
      assert.equal(llm.adapters.size, 10);
      await fiber.dispose();
      assert.equal(llm.adapters.size, 0);
    } finally {
      await fiber?.dispose();
      await ctx.stop?.();
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
