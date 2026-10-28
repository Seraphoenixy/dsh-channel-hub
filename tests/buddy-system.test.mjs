/**
 * Buddy 国区系统提示词整篇替换：夹具验证（不联网、不读真实凭据）。
 *
 * 背景：真实报障是 Buddy 国区（provider `buddy`）在正常对话里被上游以
 * `code 11128 Illegal API invocation from an unapproved channel` 拒绝。探针把
 * 触发点收敛到系统提示词里的一段 `@` 路径说明；放行办法是整篇换成
 * `src/system/buddy-prompt.ts` 里那份已验证可达的等义模板。
 *
 * 本文件只验证「替换决策与接线」这一层；真实网络验收单独记录在
 * `docs/ACCEPTANCE.md`，不能用这里的合成响应替代。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BuddyAdapter } from "../vendor/ofm/src/buddy-adapter.ts";
import { CODEBUDDY, WORKBUDDY } from "../vendor/ofm/src/product.ts";
import {
  BUDDY_SYSTEM_MODEL_SLOT,
  BUDDY_SYSTEM_ZH,
} from "../src/system/buddy-prompt.ts";
import {
  BUDDY_CN_PROVIDER,
  buddySystemFor,
  buddySystemReplacement,
  inspectBuddySystem,
  knownDshTemplates,
  matchKnownDshTemplate,
} from "../src/system/buddy-system.ts";

/** 合成凭据：只用于构造适配器，不会发往真实网络（`fetchImpl` 已被替换）。 */
const syntheticCredential = (product) => ({
  access_token: "synthetic",
  domain: product.apiDomain,
});

/** 组装一个永不联网的适配器，并把请求体交给 `onBody` 检查。 */
const makeAdapter = (product, onBody, extra = {}) => {
  const calls = [];
  const adapter = new BuddyAdapter({
    product,
    credentialRef: "SYNTHETIC_BUDDY",
    resolveCredential: async () => syntheticCredential(product),
    refresh: async () => {
      throw Error("Unexpected refresh");
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      onBody?.(body, calls.length);
      return new Response('data: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
    ...extra,
  });
  return { adapter, calls };
};

const drain = async (iterable) => {
  for await (const _ of iterable) {
    // 合成流只有 `[DONE]`，此处不需要任何 chunk。
  }
};

test("模板正文钉死为已验收的字节，且只有一处模型槽位", () => {
  // 正文的唯一来源就是 `buddy-prompt.ts` 里的模板字面量；这份指纹是逐字对照
  // 上游拦截规则定下来的，改动必须同步重跑真实网络验收，不能只改测试放行。
  const sha = createHash("sha256")
    .update(BUDDY_SYSTEM_ZH, "utf8")
    .digest("hex");
  assert.equal(BUDDY_SYSTEM_ZH.length, 3412);
  assert.equal(
    sha,
    "347ef45a50cec8fc8d8ae6359be760896cc64feb82fbc3c168318a3e88495f3b",
  );
  assert.equal(BUDDY_SYSTEM_MODEL_SLOT, "{{MODEL_ID}}");
  assert.equal(BUDDY_SYSTEM_ZH.split(BUDDY_SYSTEM_MODEL_SLOT).length, 2);
  // 结尾换行参与指纹，单独点名，避免有人「顺手」格式化掉。
  assert.ok(BUDDY_SYSTEM_ZH.endsWith("\n"));
});

test("模型槽位按请求填入真实模型 ID，且逐轮稳定", () => {
  const flash = buddySystemFor("deepseek-v4.1-flash");
  assert.ok(flash.includes("deepseek-v4.1-flash"));
  assert.ok(!flash.includes(BUDDY_SYSTEM_MODEL_SLOT));
  // 同一模型必然得到同一字符串：适配器用 sessionId 作 prompt_cache_key，
  // system 不稳定会直接打掉前缀缓存。
  assert.equal(buddySystemFor("deepseek-v4.1-flash"), flash);
  // 不同模型只差那一处。
  assert.equal(
    buddySystemFor("hy3").replace("hy3", "deepseek-v4.1-flash"),
    flash,
  );
  // 缺模型时不留字面槽位。
  assert.ok(!buddySystemFor(undefined).includes(BUDDY_SYSTEM_MODEL_SLOT));
  assert.ok(buddySystemFor("   ").length > 0);
});

test("替换决策只看 provider：Buddy 国区无条件替换，其余不动", () => {
  const system = "You are an AI agent powered by DeepSeek Harness.";
  const budget = (patch) =>
    buddySystemReplacement({ provider: "buddy", model: "m", system, ...patch });

  assert.equal(budget({}), buddySystemFor("m"));
  // 连认不出的文本也换（用户决定：无条件全量替换），所以不能拿「是否已知模板」
  // 当前置条件。
  assert.equal(budget({ system: "totally unknown text" }), buddySystemFor("m"));

  for (const provider of ["workbuddy", "codearts", "channel-hub/buddy", "", undefined]) {
    assert.equal(budget({ provider }), undefined);
  }
  // 空 system 没有替换对象。
  assert.equal(budget({ system: "" }), undefined);
  assert.equal(budget({ system: undefined }), undefined);
});

test("标题生成调用不替换，压缩调用替换", () => {
  const system = "You are an AI agent powered by DeepSeek Harness.";
  const base = { provider: "buddy", model: "m", system };
  // 标题调用的 system 是它自己的任务说明，换掉会让标题功能失效。
  assert.equal(buddySystemReplacement({ ...base, purpose: "session-title" }), undefined);
  const titleText =
    "Create a concise title for an AI coding-assistant session from the supplied human messages.";
  assert.equal(
    buddySystemReplacement({ ...base, system: titleText, purpose: "session-title" }),
    undefined,
  );
  // 压缩重放的是会话自己的 system，必须换 —— 否则压缩请求带着原文被拦截。
  assert.equal(
    buddySystemReplacement({ ...base, purpose: "compaction" }),
    buddySystemFor("m"),
  );
  // 普通对话 `purpose` 为 undefined。
  assert.equal(buddySystemReplacement({ ...base, purpose: undefined }), buddySystemFor("m"));
});

test("未识别模板：照做替换，但标记需要复核", () => {
  const verdict = inspectBuddySystem({
    provider: "buddy",
    model: "m",
    system: "some future DSH template with new instructions",
  });
  assert.equal(verdict.replaced, true);
  assert.equal(verdict.reviewNeeded, true);
  assert.equal(verdict.knownTemplate, undefined);
  assert.equal(verdict.text, buddySystemFor("m"));

  const skipped = inspectBuddySystem({
    provider: "workbuddy",
    model: "m",
    system: "x",
  });
  assert.deepEqual(skipped, { replaced: false, reason: "provider" });
  assert.deepEqual(
    inspectBuddySystem({ provider: "buddy", model: "m", system: "x", purpose: "session-title" }),
    { replaced: false, reason: "title-call" },
  );
  assert.deepEqual(
    inspectBuddySystem({ provider: "buddy", model: "m", system: "" }),
    { replaced: false, reason: "empty-system" },
  );
});

/**
 * 已知模板指纹：用**真实**抓取核对，而不是用我编的夹具自我证明。
 *
 * 抓取来自本机会话日志的 `system/message` 记录，属于用户环境、不入库；
 * 目录由 `DSH_BUDDY_TEMPLATE_DIR` 指定（默认 `.cache`），缺失时整组跳过。
 */
const templateDir = process.env.DSH_BUDDY_TEMPLATE_DIR ?? ".cache";
const captures = [
  ["sys-session-e987ea91.txt", "deepseek-v4.1-flash"],
  ["sys-session-a5b6f477.txt", "DeepSeek-V4.1-Flash"],
  ["tmpl-session-a5b6f477-0.txt", "dfmodel"],
  ["sys-session-6d599a35.txt", "hy3"],
];

test("真实抓取归一到已知模板指纹（模型行归一化后逐字节相同）", () => {
  const present = captures.filter(([name]) => existsSync(join(templateDir, name)));
  if (present.length === 0) {
    // 没有本机抓取时跳过：CI 与其它机器上不会有这些文件。
    return;
  }
  for (const [name, model] of present) {
    const text = readFileSync(join(templateDir, name), "utf8");
    const known = matchKnownDshTemplate(text);
    assert.ok(known, `${name}（${model}）应被识别为已知模板`);
    // 7974 与 7986 字符的抓取都必须归一到同一版（模型 ID 长度不同）。
    assert.match(known, /^dsh-system-/);
  }
  assert.equal(knownDshTemplates().length >= 2, true);
});

test("标题说明与随意文本不会被误判为宿主模板", () => {
  for (const text of [
    "",
    "x",
    "Create a concise title for an AI coding-assistant session.",
    "You are an AI agent powered by DeepSeek Harness.",
    // 模型行在但正文被改过 → 指纹不匹配。
    BUDDY_SYSTEM_ZH.replace("一、文件引用与工作位置", "一、文件引用"),
  ]) {
    assert.equal(matchKnownDshTemplate(text), undefined, text.slice(0, 40));
  }
});

test("适配器接线：Buddy 国区整篇替换，user/tool 内容逐字不变", async () => {
  const system = "You are an AI agent powered by DeepSeek Harness.\n\nKeep nothing else.";
  const messages = [
    { role: "user", content: [{ type: "text", text: system }] },
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", content: [{ type: "text", text: system }] },
  ];
  const options = { model: "deepseek-v4.1-flash", system, messages, tools: [], sessionId: "s-1" };
  const before = structuredClone(options);
  let sent;
  const { adapter, calls } = makeAdapter(CODEBUDDY, (body) => {
    sent = body;
  }, {
    rewriteSystem: (input) =>
      buddySystemReplacement({ provider: BUDDY_CN_PROVIDER, ...input }),
  });
  await drain(adapter.stream(options));
  assert.equal(calls.length, 1);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, buddySystemFor("deepseek-v4.1-flash"));
  // 用户与工具内容逐字不变，只有 system 被换。
  assert.equal(sent.messages[1].role, "user");
  assert.equal(sent.messages[1].content, system);
  assert.equal(sent.messages[2].role, "assistant");
  assert.equal(sent.messages[2].tool_calls[0].id, "c1");
  assert.equal(sent.messages[3].role, "tool");
  assert.equal(sent.messages[3].content, system);
  // ⚠️ 驱动不向适配器传 `sessionId`（适配器自造一个），故此处只断言该字段
  // 存在且同一适配器内稳定——前缀缓存正是靠它。
  assert.equal(typeof sent.prompt_cache_key, "string");
  assert.ok(sent.prompt_cache_key.length > 0);
  assert.deepEqual(options, before);
});

test("适配器接线：同一会话两轮发送同一份 system（前缀缓存前提）", async () => {
  const options = {
    model: "deepseek-v4.1-flash",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    sessionId: "s-2",
  };
  const systems = [];
  const { adapter } = makeAdapter(CODEBUDDY, (body) => systems.push(body.messages[0].content), {
    rewriteSystem: (input) => buddySystemReplacement({ provider: BUDDY_CN_PROVIDER, ...input }),
  });
  await drain(adapter.stream(options));
  await drain(adapter.stream(options));
  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
});

test("适配器接线：标题调用保持原样，压缩调用被替换", async () => {
  const titleText = "Create a concise title for an AI coding-assistant session from the supplied human messages.";
  const title = {
    model: "deepseek-v4.1-flash",
    system: titleText,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    purpose: "session-title",
  };
  const compaction = {
    ...title,
    system: "You are an AI agent powered by DeepSeek Harness.",
    purpose: "compaction",
  };
  const seen = [];
  const { adapter } = makeAdapter(CODEBUDDY, (body) => seen.push(body.messages[0].content), {
    rewriteSystem: (input) => buddySystemReplacement({ provider: BUDDY_CN_PROVIDER, ...input }),
  });
  await drain(adapter.stream(title));
  await drain(adapter.stream(compaction));
  assert.equal(seen[0], titleText);
  assert.equal(seen[1], buddySystemFor("deepseek-v4.1-flash"));
});

for (const product of [WORKBUDDY]) {
  test(`${product.id}: 国际版不接线，指纹规则仍按原样生效`, async () => {
    const system = "You are an AI agent powered by DeepSeek Harness.";
    const options = {
      model: "m",
      system,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    };
    const before = structuredClone(options);
    let sent;
    // 驱动只在 `buddy` 上挂钩子；这里显式按 provider 拒绝，模拟该接线。
    const { adapter } = makeAdapter(product, (body) => {
      sent = body;
    }, {
      rewriteSystem: (input) =>
        buddySystemReplacement({ provider: product.id, ...input }),
    });
    await drain(adapter.stream(options));
    // 不含整篇模板；只有既有的「身份句」指纹规则生效（接入前行为）。
    assert.ok(!sent.messages[0].content.includes("文件引用与工作位置"));
    assert.equal(
      sent.messages[0].content,
      "You are an AI agent running in DeepSeek Harness.",
    );
    assert.deepEqual(options, before);
  });
}

test("钩子抛错时原样发送，不阻断请求", async () => {
  const system = "You are an AI agent powered by DeepSeek Harness.";
  const options = {
    model: "m",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  };
  let sent;
  const { adapter, calls } = makeAdapter(CODEBUDDY, (body) => {
    sent = body;
  }, {
    rewriteSystem: () => {
      throw Error("boom");
    },
  });
  await drain(adapter.stream(options));
  assert.equal(calls.length, 1);
  // 指纹规则仍会改写这一句（原有行为），但绝不该是整篇模板。
  assert.ok(!sent.messages[0].content.includes("文件引用与工作位置"));
  assert.ok(sent.messages[0].content.includes("DeepSeek Harness"));
});

test("未注入钩子时行为与接入前一致", async () => {
  const system = "You are an AI agent powered by DeepSeek Harness.";
  const options = {
    model: "m",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  };
  let sent;
  const { adapter } = makeAdapter(CODEBUDDY, (body) => {
    sent = body;
  });
  await drain(adapter.stream(options));
  assert.equal(sent.messages[0].content, "You are an AI agent running in DeepSeek Harness.");
});
