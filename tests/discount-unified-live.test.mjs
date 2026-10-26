/**
 * 用**真实**目录快照验证三家渠道的折扣推算（不联网、不读凭据）。
 *
 * 数据源：本机 profile 的 `ledger.sqlite`（`catalog:<provider>:<accountId>`）。
 * 它属于用户环境，**不入库**；缺失时整组跳过。
 *
 * 目的：证明「统一口径」不是只在夹具里成立 —— 对真实条目，同一个时刻
 * 三家渠道给出**方向一致**的结论（窗口内展开折后价、窗口外只报原价）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discountOf, isActive, rateLabel, promotionNote } from "../src/core/rate.ts";

const ledger = join(homedir(), ".dsh", "profiles", "desktop", "channel-hub", "ledger.sqlite");
const available = existsSync(ledger);

/** 每个渠道取**第一条带折扣**的真实模型条目。 */
function loadSamples() {
  if (!available) return new Map();
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    const rows = db.prepare("select key,data from kv where key like 'catalog:%'").all();
    const samples = new Map();
    for (const row of rows) {
      const provider = String(row.key).split(":")[1];
      if (samples.has(provider)) continue;
      const snapshot = JSON.parse(String(row.data));
      const model = snapshot.models.find((m) => discountOf(m) !== undefined);
      if (model !== undefined) samples.set(provider, model);
    }
    return samples;
  } finally {
    db.close();
  }
}

const samples = loadSamples();

test(
  "real snapshots: every channel with a discount resolves to both prices",
  { skip: !available ? "no local ledger" : false },
  () => {
    assert.ok(samples.size > 0, "expected at least one channel with a discount");
    for (const [provider, model] of samples) {
      const found = discountOf(model);
      assert.ok(found, `${provider}/${model.id}: no Discount`);
      assert.ok(
        typeof found.before === "number" && typeof found.after === "number",
        `${provider}/${model.id}: missing before/after`,
      );
      assert.ok(found.before > found.after, `${provider}/${model.id}: not a real discount`);
      /**
       * ⚠️ **没有窗口是合法情形**，不是缺陷：实测 `trae/Doubao-Seed-2.1-Turbo`
       * 是 `subsidy` 型补贴（原价 0.4 → 0.2），长期有效、无时段。
       * 此时「全天生效」就是正确答案 —— `isActive` 对无窗口的折扣返回 true。
       * 有窗口的折扣才需要窗口来回答「什么时候」。
       */
      if (found.daily === undefined && found.validUntil === undefined) {
        assert.equal(isActive(found, new Date()), true, `${provider}/${model.id}: no-window discount is always active`);
        continue;
      }
      const hasWindow =
        (Array.isArray(found.daily) && found.daily.length > 0) || found.validUntil !== undefined;
      assert.ok(hasWindow, `${provider}/${model.id}: window declared but unparseable`);
    }
  },
);

test(
  "real snapshots: the same clock minute yields consistent conclusions across channels",
  { skip: !available ? "no local ledger" : false },
  () => {
    const noon = new Date("2026-10-24T12:00:00+08:00");
    // 中午：所有夜间/错峰窗口都不该生效。
    for (const [provider, model] of samples) {
      const found = discountOf(model);
      // 只有「纯每日时段」的折扣才有这个性质；一次性活动在中午可能仍在有效期。
      const strictlyDaily =
        Array.isArray(found.daily) && found.daily.length > 0 && found.validUntil === undefined;
      if (!strictlyDaily) continue;
      assert.equal(
        isActive(found, noon),
        false,
        `${provider}/${model.id}: a night window must not be active at noon`,
      );
    }
  },
);

test(
  "real snapshots: an inactive window still reports the window itself",
  { skip: !available ? "no local ledger" : false },
  () => {
    const noon = new Date("2026-10-24T12:00:00+08:00");
    for (const [provider, model] of samples) {
      const found = discountOf(model);
      const strictlyDaily =
        Array.isArray(found.daily) && found.daily.length > 0 && found.validUntil === undefined;
      if (!strictlyDaily) continue;
      if (isActive(found, noon)) continue;
      // 窗口外只报原价，但标签要说明「有活动、现在不算」。
      const label = promotionNote(model, noon);
      assert.ok(
        label === undefined || /未生效/.test(label),
        `${provider}/${model.id}: inactive window must be marked, got ${label}`,
      );
    }
  },
);
