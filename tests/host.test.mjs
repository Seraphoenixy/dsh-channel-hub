import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
    /**
     * 镜像宿主 `ctx.credentials` 的**真实方法面**。
     *
     * ⚠️ 这里刻意**只有** `resolve` / `describe` / `set` / `unset` —— 与
     * `@deepseek-ai/dsh-credentials-local` 一致。曾经的桩多写了一个
     * `delete()`，于是插件里那句 `credentials.delete?.()` 在这个夹具里畅通无阻，
     * 直到真实宿主上才抛 `TypeError: target[key] is not a function`，
     * 表现为「删除报错但账号又确实删掉了」。夹具方法面一旦比真机宽，
     * 测试就不再证明任何东西。
     */
    class Credentials extends Service {
      constructor(ctx) {
        super(ctx, "credentials");
      }
      async resolve(ref) {
        credentialRef(ref);
        const value = records.get(ref);
        return value === undefined ? undefined : { value, source: "test" };
      }
      async describe(ref) {
        credentialRef(ref);
        return { configured: records.has(ref), writable: true };
      }
      async set(ref, value) {
        credentialRef(ref);
        records.set(ref, value);
      }
      async unset(ref) {
        credentialRef(ref);
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
          {
            // 渠道未注册的账号（模拟「删了驱动没删账号」的遗留）
            id: "zcode-orphan",
            provider: "zcode",
            nickname: "Orphan",
            credentialRef: "ZCODE_ORPHAN",
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
      assert.equal(channels.length, 9);
      assert.equal(
        channels.some((c) => c.id === "lobsterai"),
        false,
        "LobsterAI support was removed from this build",
      );
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
      /**
       * 大窗口档：只有 Trae 声明该能力，且**默认关闭**。
       *
       * 默认关是本次修正的核心（目录只下发一个 `consumption_rate`，
       * 开启 Max 后界面显示的倍率与实扣不符）。其余渠道不得出现这个开关。
       */
      assert.deepEqual(
        trae?.extendedContext,
        { supported: true, enabled: false },
        "the extended window tier must be opt-in and default off",
      );
      assert.equal(
        channels.filter((c) => c.extendedContext).length,
        1,
        "no other channel has an extended window tier",
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
      /**
       * 「更新模型」现在是区块级动作（不带 `provider` ⇒ 全部渠道）。
       *
       * 夹具的 fetch 恒抛错，于是 CodeBuddy 的账号目录必然失败，而其余没有
       * 账号的渠道「无事可做」。要求：**部分失败不抛错**，逐个点名失败渠道，
       * 成功的渠道照常计入 —— 界面才能说出「已更新 N/M」而不是笼统失败。
       *
       * ⚠️ 这里同时锁住「快照 error 也算失败」：`driver.reload()` 把上游失败
       * 吞成 `{stale: true, error}` 的快照并正常 resolve，只看 Promise 的
       * rejected 会把满盘皆错报成「全部更新成功」。
       */
      const bulk = await plugin.dispatch("models.refresh", {});
      assert.equal(bulk.total, 9, "the bulk refresh covers every channel");
      assert.ok(
        bulk.failures.some((f) => f.startsWith("buddy：")),
        "a channel whose directory request failed must be named: " +
          JSON.stringify(bulk.failures),
      );
      /**
       * ⚠️ 三个桶必须**互斥且穷尽**（2026-10-29 修）。
       *
       * 旧实现把「没有账号的渠道」也算进 `refreshed`：夹具里 9 个渠道只有
       * buddy 有账号，界面却显示「已更新 8/9」——用户点完看不到任何变化，
       * 于是报「按钮不能用」。现在无账号的渠道进 `skipped`，既不算成功也
       * 不算失败。
       */
      assert.equal(
        bulk.refreshed + bulk.failures.length + bulk.skipped.length,
        bulk.total,
        "every channel must land in exactly one bucket (refreshed / failed / skipped)",
      );
      assert.ok(
        bulk.skipped.includes("qoder"),
        "a channel with no accounts must be skipped, not refreshed: " +
          JSON.stringify(bulk.skipped),
      );
      assert.ok(
        bulk.refreshed < bulk.total,
        "channels that did nothing must not be counted as refreshed",
      );
      /**
       * 大窗口档开关：真实 RPC 路径 + 落库 + 拒绝非法渠道。
       *
       * ⚠️ 这里断言的是**开关本身**，不是「Trae 真的走 1M」——后者需要真实
       * 账号与远端 `max_mode` 目录，属于真实验收，不能用夹具冒充。
       */
      await plugin.dispatch("channels.setExtendedContext", {
        provider: "trae",
        enabled: true,
      });
      assert.equal(
        (await plugin.dispatch("channels.list")).find((c) => c.id === "trae")
          .extendedContext.enabled,
        true,
        "turning the tier on must be visible to the UI immediately",
      );
      await plugin.dispatch("channels.setExtendedContext", {
        provider: "trae",
        enabled: false,
      });
      assert.equal(
        (await plugin.dispatch("channels.list")).find((c) => c.id === "trae")
          .extendedContext.enabled,
        false,
      );
      await assert.rejects(
        () =>
          plugin.dispatch("channels.setExtendedContext", {
            provider: "qoder",
            enabled: true,
          }),
        /大窗口档/,
        "a channel without the tier must reject rather than silently accept",
      );
      await assert.rejects(
        () =>
          plugin.dispatch("channels.setExtendedContext", {
            provider: "trae",
            enabled: "yes",
          }),
        /boolean/,
      );
      // 渠道未注册的账号（驱动不存在）：必须被报告出来，而不是隐形留在磁盘上。
      // 真实遗留：删掉 zcode 驱动后，账号行与三个快照键又活了 26 小时。
      assert.deepEqual(
        (await plugin.dispatch("accounts.orphans")).map((a) => a.id),
        ["zcode-orphan"],
        "accounts whose provider has no driver must be reported",
      );
      assert.equal(
        (await plugin.dispatch("channels.list")).some((c) => c.id === "zcode"),
        false,
        "an orphaned provider must not become a channel",
      );
      // 删号必须连带清掉 per-account 快照，否则每删一个号都留 3–4 个孤儿键。
      const ledger = new DatabaseSync(join(data, "ledger.sqlite"));
      ledger.exec("PRAGMA busy_timeout = 5000");
      const seed = (key, value) =>
        ledger
          .prepare(
            "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
          )
          .run(key, JSON.stringify(value));
      for (const key of [
        "catalog:zcode:zcode-orphan",
        "balance:zcode-orphan",
        "checkin:zcode-orphan",
        "identity:zcode/zcode-orphan",
      ])
        seed(key, { seeded: true });
      seed("checkin:buddy-1", { seeded: true }); // 对照：别的账号的键不能被误删
      ledger.close();
      // 凭据：删号必须连带注销凭据，且不能因为「宿主没有 delete 方法」而报错。
      // ref 由插件加 `CHANNEL_HUB_<hash>_` 前缀，这里按同一算法预置。
      const namespace =
        "CHANNEL_HUB_" +
        createHash("sha256").update(data).digest("hex").slice(0, 12) +
        "_";
      records.set(namespace + "ZCODE_ORPHAN", "orphan-secret");
      records.set(namespace + "BUDDY_1", "buddy-secret"); // 对照：别的账号的凭据不能误删

      assert.equal(
        await plugin.dispatch("accounts.delete", { id: "zcode-orphan" }),
        true,
      );
      assert.equal(
        records.has(namespace + "ZCODE_ORPHAN"),
        false,
        "deleting an account must unset its credential (the host API is unset, not delete)",
      );
      assert.equal(
        records.get(namespace + "BUDDY_1"),
        "buddy-secret",
        "other accounts' credentials must survive",
      );
      assert.deepEqual(await plugin.dispatch("accounts.orphans"), []);
      assert.deepEqual(
        (await plugin.dispatch("channels.list"))
          .find((c) => c.id === "buddy")
          .accounts.map((a) => a.id),
        ["buddy-2", "buddy-1"],
        "deleting an orphan must not disturb a normal channel",
      );

      const after = new DatabaseSync(join(data, "ledger.sqlite"));
      const keys = after
        .prepare("SELECT key FROM kv ORDER BY key")
        .all()
        .map((row) => row.key);
      after.close();
      assert.equal(
        keys.some((key) => key.includes("zcode")),
        false,
        "deleting an account must purge its catalog / balance / checkin / identity rows",
      );
      assert.equal(
        keys.includes("checkin:buddy-1"),
        true,
        "other accounts' snapshots must survive",
      );
      /**
       * 大窗口档开关必须**跨重启存活**：它是用户显式选择，不能每次启动都退回
       * 产品默认（那等于每次都替用户重选一次）。
       *
       * 这里直接读库确认落的是布尔值 —— 存成字符串 "true" 会在 `restore()`
       * 的 `typeof saved === "boolean"` 判断处被静默丢掉。
       */
      await plugin.dispatch("channels.setExtendedContext", {
        provider: "trae",
        enabled: true,
      });
      const persisted = new DatabaseSync(join(data, "ledger.sqlite"));
      const stored = persisted
        .prepare("SELECT data FROM kv WHERE key=?")
        .get("extended-context:trae");
      persisted.close();
      assert.equal(
        JSON.parse(String(stored?.data)),
        true,
        "the tier switch must be stored as a JSON boolean",
      );
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
  "actual host prepareCall -> Qoder WASM and Buddy system compatibility -> persistent requests",
  { skip: !host },
  async () => {
    const { Context, Service } = host;
    const { LlmRuntime, createUserMessage, createSystemMessage } = await import(
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
            id: "buddy-test",
            provider: "buddy",
            nickname: "Buddy fixture",
            credentialRef: "BUDDY_TEST",
            enabled: true,
            refreshable: false,
            createdAt: Date.now(),
          },
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
      [namespace + "BUDDY_TEST", JSON.stringify({ access_token: "synthetic-buddy", domain: "copilot.tencent.com" })],
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
    let buddyInference = 0;
    const guiFirst = "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.";
    const guiSecond = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.';
    const guiPair = guiFirst + " " + guiSecond;
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
        if (url.startsWith("https://copilot.tencent.com/"))
          return Response.json({ data: { models: [{ id: "hy3", name: "Hy3" }], agents: [{ name: "craft", models: ["hy3"] }] } });
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
      if (url === "https://copilot.tencent.com/v2/chat/completions") {
        buddyInference++;
        const body = JSON.parse(init.body);
        // Buddy 国区：系统提示词被整篇换成 `src/system/buddy-system.ts` 的模板
        // （模型槽位按本次请求填 hy3）。多条 system 会换成同一份模板，重复的
        // 只保留第一条，所以这里只剩一条 system。
        const systems = body.messages.filter((m) => m.role === "system");
        assert.equal(systems.length, 1);
        assert.match(systems[0].content, /你是在 DeepSeek Harness 中为用户完成编程工作的 AI 助手/);
        assert.match(systems[0].content, /本次使用的模型是 hy3。/);
        assert.ok(!systems[0].content.includes("{{MODEL_ID}}"));
        assert.equal(body.messages.filter((m) => m.role === "user")[0].content, guiPair);
        assert.equal(body.tools[0].function.name, "read_file");
        return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
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
      /**
       * 部分失败的渠道按**账号快照**分别计（2026-10-30，用户报障「更新模型
       * 部分失败，也得把成功的那部分状态正确刷新了」）。
       *
       * 本夹具天然就是「一半成功一半失败」：workbuddy 两个账号，WORKBUDDY_OK
       * 的 /v3/config 正常、WORKBUDDY_FAIL 的 500。旧口径把整个渠道计成
       * 失败（`refreshed` 不含它），但 WORKBUDDY_OK 的目录确实刷新了 ——
       * 结果行否认已发生的事实。现在要求：
       * 1. `refreshedAccounts` 把成功账号数如实回报（成功账号计入，
       *    workbuddy 的坏账号不计）；
       * 2. `partial` 点名该渠道「成功/总数」（`workbuddy: "1/2"`）；
       * 3. `failures` 照旧点名坏账号的快照错误；
       * 4. 桶互斥性以**渠道**口径维持（refreshed + failures + skipped =
       *    total）—— 部分失败渠道归入 failures 桶，其成功账号只进
       *    `refreshedAccounts`，两套口径不混。
       */
      const bulkPartial = await plugin.dispatch("models.refresh", {});
      assert.equal(
        bulkPartial.partial?.workbuddy,
        "1/2",
        "a half-success channel must report how many accounts actually refreshed: " +
          JSON.stringify(bulkPartial),
      );
      assert.ok(
        (bulkPartial.refreshedAccounts ?? 0) >= 1,
        "successful accounts must be counted even when their channel reports a failure",
      );
      assert.equal(
        bulkPartial.refreshed + bulkPartial.failures.length + bulkPartial.skipped.length,
        bulkPartial.total,
        "channel buckets stay mutually exclusive; account counts live in refreshedAccounts",
      );
      assert.ok(
        bulkPartial.failures.some((f) => f.startsWith("workbuddy：")),
        "the failing account's snapshot error must still be named",
      );
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
      /**
       * 上下文窗口必须经 `resolveModelInfo` 送到宿主。
       *
       * `listModels` 的返回值**不含** `context`（宿主
       * `normalizeModelInfo` 只从 `resolveModel` 取），故这里读 `prepareCall`
       * 的结果 —— 它才是 `dsh-compaction-basic` 定价自动压缩阈值的来源。
       * 夹具的 Gemini 目录只有 `displayName`（与真实响应同形），窗口必须由
       * 静态表补位；漏了这条，宿主会在每一步抛
       * `no context capacity for channel-hub/gemini/…`。
       */
      const geminiCall = await llm.prepareCall({
        provider: "channel-hub/gemini",
        model: "gemini-3.8-flash",
      });
      // `prepareCall` 把上下文放在**返回值的 `context`**（不是 `config`），
      // 见宿主 `resolveCallWithInfo`。
      assert.equal(
        geminiCall.context?.contextWindow,
        1_000_000,
        "the Gemini static window must reach the host",
      );
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
      await plugin.dispatch("models.refresh", { provider: "buddy" });
      const buddyCall = await llm.prepareCall({ provider: "channel-hub/buddy", model: "hy3", maxTokens: 512 });
      const buddyChunks = [];
      for await (const chunk of buddyCall.stream({
        ...buddyCall.config,
        system: "You are an AI agent powered by DeepSeek Harness.\n\n" + guiPair,
        messages: [createSystemMessage(guiPair), createUserMessage({ content: [{ type: "text", text: guiPair }] })],
        tools: [{ name: "read_file", description: "Read a synthetic file", parameters: { type: "object", properties: {} } }],
      })) buddyChunks.push(chunk);
      assert.equal(buddyInference, 1);
      assert.ok(buddyChunks.some(c => c.type === "text-delta" && c.text === "OK"), JSON.stringify(buddyChunks));
      const buddyRecords = await plugin.dispatch("requests.list", { provider: "buddy" });
      assert.equal(buddyRecords.total, 1);
      assert.equal(buddyRecords.items[0].outcome, "success");
      assert.equal(buddyRecords.items[0].attempts[0].accountId, "buddy-test");
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
      assert.equal(llm.adapters.size, 9);
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
