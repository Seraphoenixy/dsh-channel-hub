import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BUDGET_HEADROOM,
  CONTEXT_BUDGET_TIERS,
  displayLimitedModel,
  estimatedCompactionTokens,
  isContextBudgetTier,
  limitedContextWindow,
  normalizeContextBudget,
} from "../src/core/context-limit.ts";
import { contextTier } from "../src/core/context.ts";

const K = 1024;
const BUDGET = 524_288; // 512K

test("档位是固定集合，非法值按跟随上游处理", () => {
  assert.deepEqual(
    [...CONTEXT_BUDGET_TIERS],
    [524_288, 786_432, 1_048_576],
  );
  assert.equal(isContextBudgetTier(524_288), true);
  assert.equal(isContextBudgetTier(300_000), false);
  assert.equal(isContextBudgetTier("524288"), false);
  assert.equal(isContextBudgetTier(null), false);
  assert.equal(normalizeContextBudget(786_432), 786_432);
  // 低于 512K 的档位不再发布：常规档普遍在 200K 以上，压到那里没有可用预算。
  assert.equal(normalizeContextBudget(262_144), undefined);
  assert.equal(normalizeContextBudget(300_000), undefined);
  assert.equal(normalizeContextBudget(null), undefined);
  assert.equal(normalizeContextBudget(undefined), undefined);
});

test("跟随上游时不改变窗口", () => {
  assert.equal(limitedContextWindow(1_000_000, 0, undefined), 1_000_000);
  assert.equal(limitedContextWindow(1_000_000, 128_000, undefined), 1_000_000);
  // 非法上游值原样返回，不编造容量。
  assert.equal(limitedContextWindow(undefined, 0, BUDGET), undefined);
  assert.equal(limitedContextWindow(0, 0, BUDGET), undefined);
});

test("按模型输出预留反算，只收紧不放大", () => {
  // 未声明输出预留：512K + 64K headroom。
  assert.equal(
    limitedContextWindow(1_000_000, 0, BUDGET),
    BUDGET + CONTEXT_BUDGET_HEADROOM,
  );
  // 声明 128K 输出预留：多让出 128K。
  assert.equal(
    limitedContextWindow(1_000_000, 128_000, BUDGET),
    BUDGET + 128_000 + CONTEXT_BUDGET_HEADROOM,
  );
  // 上游窗口更小：min 生效，预算不会把窗口放大。
  assert.equal(limitedContextWindow(200_000, 32_000, BUDGET), 200_000);
  assert.equal(limitedContextWindow(256_000, 0, BUDGET), 256_000);
});

test("估算压缩点与宿主公式一致", () => {
  // threshold = min(window × 0.8, window − reserved − headroom)
  assert.equal(
    estimatedCompactionTokens(BUDGET + CONTEXT_BUDGET_HEADROOM, 0),
    Math.floor((BUDGET + CONTEXT_BUDGET_HEADROOM) * 0.8),
  );
  assert.equal(estimatedCompactionTokens(200_000, 32_000), 102_464);
  // 预留吃满窗口时宿主会拒绝该目标，这里不给数字。
  assert.equal(estimatedCompactionTokens(65_536, 0), undefined);
  assert.equal(estimatedCompactionTokens(100_000, 100_000), undefined);
});

test("展示副本保留上游值并附估算压缩点", () => {
  const capped = displayLimitedModel(
    { id: "dfmodel", contextWindow: 1_000_000 },
    BUDGET,
  );
  assert.equal(capped.contextWindow, BUDGET + CONTEXT_BUDGET_HEADROOM);
  assert.equal(capped.upstreamContextWindow, 1_000_000);
  assert.equal(
    capped.estimatedCompactionTokens,
    Math.floor((BUDGET + CONTEXT_BUDGET_HEADROOM) * 0.8),
  );

  // 未收紧的模型不加任何额外字段（界面据此不显示限制提示）。
  const untouched = displayLimitedModel(
    { id: "hy3", contextWindow: 192_000 },
    BUDGET,
  );
  assert.equal(untouched.contextWindow, 192_000);
  assert.equal(untouched.upstreamContextWindow, undefined);
  assert.equal(untouched.estimatedCompactionTokens, undefined);

  // 跟随上游时与输入完全一致。
  assert.deepEqual(
    displayLimitedModel({ id: "x", contextWindow: 1_000_000 }, undefined),
    {
      id: "x",
      contextWindow: 1_000_000,
    },
  );
});

test("大窗口档同受全局上限约束", () => {
  const limited = displayLimitedModel(
    {
      id: "glm-5.3-flash",
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      maxModeOutputTokens: 64_000,
    },
    BUDGET,
  );
  assert.equal(limited.contextWindow, 200_000);
  assert.equal(
    limited.maxContextWindow,
    BUDGET + 64_000 + CONTEXT_BUDGET_HEADROOM,
  );
  assert.equal(limited.upstreamMaxContextWindow, 1_000_000);
  assert.equal(contextTier(limited)?.extended, limited.maxContextWindow);

  // 被压到不大于常规档时不再算「另一档」，档位徽标随之消失。
  const flattened = displayLimitedModel(
    { id: "x", contextWindow: 700_000, maxContextWindow: 900_000 },
    BUDGET,
  );
  assert.equal(flattened.contextWindow, 589_824);
  assert.equal(flattened.maxContextWindow, 589_824);
  assert.equal(contextTier(flattened)?.extended, undefined);
});
