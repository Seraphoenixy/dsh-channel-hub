import { createHash } from "node:crypto";
import {
  BUDDY_SYSTEM_MODEL_SLOT,
  BUDDY_SYSTEM_ZH,
} from "./buddy-prompt.ts";

/**
 * 模型身份行的唯一可变处。
 *
 * 基准模板里这一行是 `You are a coding agent powered by the <模型> model.`
 * 模型 ID 每次都可能不同（实测 `deepseek-v4.1-flash`、`DeepSeek-V4.1-Flash`、
 * `dfmodel`、`hy3`），但**其余全文逐字固定**。故识别宿主模板时先把这一行归一化，
 * 再对整篇求哈希 —— 这样「同一版模板 + 不同模型」得到同一个指纹。
 */
const MODEL_LINE = /You are a coding agent powered by the ([^\n]+?) model\./;

/**
 * 已知的 DSH 内置 system 模板版本：`归一化后长度 + sha256`。
 *
 * 实测来源（会话日志 `system/message` 记录，以及压缩重放的前缀）：
 * - 7986 字符 / 40 个工具（本机 desktop profile 当前版本）；
 * - 5764 字符 / 32 个工具的上一版。
 * 四个不同模型的真实抓取（`deepseek-v4.1-flash`、`DeepSeek-V4.1-Flash`、
 * `dfmodel`、`hy3`）都稳定归一化到各自指纹，说明识别规则可复现。
 */
const KNOWN_DSH_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "dsh-system-7986",
    length: 7976,
    sha256:
      "7b14907adddb3045450e070a8f8f28c72cd41ba1ab55aa56deb9e4d29573f59b",
  }),
  Object.freeze({
    id: "dsh-system-5764",
    length: 5770,
    sha256:
      "1e39fd97cc492ed67430a5224f930216683e5edb3905ed410ac02183fd3eef25",
  }),
]);

/** Buddy 国区的 provider id（CodeBuddy CN / WorkBuddy 国区是同一产品）。 */
export const BUDDY_CN_PROVIDER = "buddy";

/**
 * 唯一不替换的旁路调用：会话标题生成。
 *
 * 标题调用的 `system` 是它**自己的任务说明**
 * （`@deepseek-ai/dsh-session-title-first-prompt-llm` 的 `systemPrompt()`：
 * “Create a concise title for an AI coding-assistant session…”，481 字符，
 * 实测经 adapter 直发返回 200），不含人格设定。换成 Buddy 模板等于让模型
 * 去扮演编程助手而不是起标题，标题功能会直接失效。
 *
 * 压缩（`purpose: 'compaction'`）**不在**例外里：它重放会话前缀，其中那条
 * system 就是当前会话自己的系统提示词（`dsh-compaction-basic` 的
 * `buildSummarizationInput` 把 `system/message` 放在 `messages[0]`），
 * 恰恰应该换成 Buddy 模板 —— 否则压缩请求会带着原文被 11128 拦截，压缩功能
 * 在 Buddy 国区整体不可用。
 */
const TITLE_PURPOSE = "session-title";

/**
 * 替换决策的入参。
 *
 * `provider` 是渠道 id（`buddy` / `workbuddy` …），`model` 是本次请求的真实
 * 模型 ID，`system` 是本次要发送的系统提示词，`purpose` 是宿主的旁路调用标记
 * （普通对话为 `undefined`）。
 */
export interface BuddySystemRequest {
  provider: string;
  model?: string | undefined;
  system?: string | undefined;
  purpose?: string | undefined;
}

/** 替换决策的观察结果。 */
export type BuddySystemVerdict =
  | { replaced: false; reason: "provider" | "title-call" | "empty-system" }
  | {
      replaced: true;
      knownTemplate: string | undefined;
      reviewNeeded: boolean;
      model: string | undefined;
      text: string;
    };

/**
 * 把模型身份行替换成固定占位符后的全文。
 * @param text 原始 system 文本。
 * @returns 归一化文本；不含模型身份行时原样返回。
 */
const normalizeModelLine = (text: string): string =>
  text.replace(MODEL_LINE, "You are a coding agent powered by the {{MODEL}} model.");

/**
 * 判定一段 system 文本是否为**已知**的 DSH 内置模板。
 *
 * 只用于**观察与告警**，不作为替换的前置条件（见 {@link buddySystemReplacement}）。
 * @param text system 文本。
 * @returns 命中的版本 id；认不出时返回 `undefined`。
 */
export const matchKnownDshTemplate = (text?: string): string | undefined => {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const normalized = normalizeModelLine(text);
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  const hit = KNOWN_DSH_TEMPLATES.find(
    (entry) => entry.length === normalized.length && entry.sha256 === digest,
  );
  return hit?.id;
};

/**
 * 填入模型 ID，得到本次请求要发送的完整 system 提示词。
 *
 * 同一个模型、同一版模板必然得到同一字符串 —— 这很重要：适配器把
 * `prompt_cache_key` 设为 `sessionId`，system 逐字稳定才有前缀缓存命中
 * （实测同一段 8k token 前缀：带该字段命中 7808，不带为 0）。
 * @param modelId 本次请求的真实模型 ID。
 */
export const buddySystemFor = (modelId?: string): string => {
  const id =
    typeof modelId === "string" && modelId.trim().length > 0
      ? modelId.trim()
      : "unknown";
  return BUDDY_SYSTEM_ZH.split(BUDDY_SYSTEM_MODEL_SLOT).join(id);
};

/**
 * 决定是否把本次 system 换成 Buddy 国区的完整模板。
 *
 * 用户决定：「渠道为 buddy（国区）时，无条件全量替换系统提示词」。因此判定
 * 只看 provider —— **不**看内容是否与某个已知版本一致，也不看工具集、模型族
 * 或客户端版本。这样即便 DSH 升级改了系统提示词，Buddy 国区仍走这份已验证
 * 可放行的模板，不会退回被 11128 拦截的原文。
 *
 * 三个必须保留的例外（都不是「系统提示词」本体）：
 * 1. 标题生成调用带的是它自己的任务说明，不是当前会话的人格设定；
 * 2. 空 `system`（无 system 消息的调用）没有可替换的对象；
 * 3. provider 不是 `buddy`（含 WorkBuddy 国际版）一律不动。
 *
 * 版本漂移时替换照做，但 {@link inspectBuddySystem} 会报「未识别模板」，
 * 由调用方记一条告警 —— 新模板里若有本模板未覆盖的指令，只能靠这条告警
 * 被人发现，属于「无条件替换」的已知代价。
 *
 * @param input provider id、本次模型、本次 `system` 与可选的 `purpose`。
 * @returns 要发送的 system 文本；`undefined` 表示保持原样。
 */
export const buddySystemReplacement = ({
  provider,
  model,
  system,
  purpose,
}: BuddySystemRequest): string | undefined => {
  if (provider !== BUDDY_CN_PROVIDER) return undefined;
  if (purpose === TITLE_PURPOSE) return undefined;
  if (typeof system !== "string" || system.length === 0) return undefined;
  return buddySystemFor(model);
};

/**
 * 替换决策的观察结果，供日志与夹具使用。
 * @param input 同 {@link buddySystemReplacement}。
 */
export const inspectBuddySystem = (input: BuddySystemRequest): BuddySystemVerdict => {
  const replacement = buddySystemReplacement(input);
  if (replacement === undefined) {
    const reason =
      input.provider !== BUDDY_CN_PROVIDER
        ? "provider"
        : input.purpose === TITLE_PURPOSE
          ? "title-call"
          : "empty-system";
    return { replaced: false, reason };
  }
  const known = matchKnownDshTemplate(input.system);
  return {
    replaced: true,
    // 认不出宿主模板时替换照做（用户要求无条件），但必须能被发现。
    knownTemplate: known,
    reviewNeeded: known === undefined,
    model: input.model,
    text: replacement,
  };
};

/** 供夹具使用的已知版本清单（冻结副本）。 */
export const knownDshTemplates = () => KNOWN_DSH_TEMPLATES;
