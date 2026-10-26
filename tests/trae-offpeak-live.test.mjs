/**
 * 用**真实** Trae 目录快照验证时段折扣链路（不联网、不读凭据）。
 *
 * 数据源：`~/.dsh/trae-cn/models.json` —— 由 `dsh-workbuddy-trae-qoder-connect`
 * 的 `scripts/export-trae-plain.mjs` 从 IDE 本地缓存导出。它是本机唯一一份
 * 真实 Trae 目录，用它做**形状核对**，而不是靠我编的夹具自我证明。
 *
 * ⚠️ 该文件属于用户环境，**不入库**。文件缺失时整组跳过（不失败），
 * 因为 CI / 其它机器上不会有它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rateLabel, promotionNote, promotionWindow } from "../src/core/rate.ts";
import { readOffPeakDiscount } from "../vendor/ofm/src/trae.ts";

const snapshotPath = join(homedir(), ".dsh", "trae-cn", "models.json");
const available = existsSync(snapshotPath);
const snapshot = available
  ? JSON.parse(readFileSync(snapshotPath, "utf8"))
  : { models: [] };

/**
 * 把本地快照的 `raw.features` 折成 vendor 读的 `display_contact_config` 字符串。
 *
 * 两者是**同一份数据的两种形态**：导出脚本从 IDE 缓存拿到的 `features` 是
 * 对象，而 `batch_get_detail_param` 下发的 `display_contact_config` 是它的
 * JSON 字符串化。键集完全对应（`activity_discount` / `consumption_rate` /
 * `reasoning` / `context_windows`），故这里做等价转换。
 */
function asEntry(model) {
  const features = model.raw?.features;
  if (!features) return undefined;
  return { display_contact_config: JSON.stringify(features) };
}

test(
  "real Trae snapshot: off-peak discounts are parsed for the models that carry them",
  { skip: !available ? "no local Trae snapshot" : false },
  () => {
    const parsed = snapshot.models
      .map((m) => ({ id: m.id, entry: asEntry(m) }))
      .filter((x) => x.entry !== undefined)
      .map((x) => ({ id: x.id, offPeak: readOffPeakDiscount(x.entry) }))
      .filter((x) => x.offPeak !== undefined);

    // 实测至少这几条带错峰窗口（见验收记录 2026-10-24）。
    const ids = parsed.map((x) => x.id);
    for (const expected of [
      "DeepSeek-V4-Flash-Official",
      "DeepSeek-V4-Pro-Official",
      "deepseek-v4.1-flash",
    ]) {
      assert.ok(
        ids.includes(expected),
        `${expected} carries off_peak.time_windows but was not parsed`,
      );
    }

    // 每一条都必须有真实降价 + 至少一个窗口。
    for (const { id, offPeak } of parsed) {
      assert.ok(offPeak.beforeRate > offPeak.afterRate, `${id}: not a real discount`);
      assert.ok(offPeak.windows.length > 0, `${id}: no usable window`);
    }
  },
);

test(
  "real Trae snapshot: a snapshot taken outside the window still yields the discount",
  { skip: !available ? "no local Trae snapshot" : false },
  () => {
    // 这是本次缺陷的原始现场：`current.discount_type === "none"` 的条目
    // （窗口外抓的）在旧实现里整条丢失。
    const flash = snapshot.models.find((m) => m.id === "DeepSeek-V4-Flash-Official");
    assert.ok(flash, "fixture model missing");
    const entry = asEntry(flash);
    const features = flash.raw.features;
    assert.equal(
      features.activity_discount.data.current.discount_type,
      "none",
      "this fixture must reproduce the outside-the-window snapshot",
    );
    assert.ok(
      features.activity_discount.data.off_peak.time_windows.length > 0,
      "the same entry must still declare the windows",
    );

    const offPeak = readOffPeakDiscount(entry);
    assert.ok(offPeak, "the discount must survive a none-typed snapshot");
    // 00:00–08:00 内 ⇒ 折后价；12:00 ⇒ 原价。
    const inside = new Date("2026-10-24T03:00:00+08:00");
    const outside = new Date("2026-10-24T12:00:00+08:00");
    const model = { creditsRate: flash.raw.features.consumption_rate.data.rate, offPeak };
    assert.equal(rateLabel(model, inside), "x0.2→x0.1");
    assert.equal(rateLabel(model, outside), "x0.2");
    assert.equal(promotionNote(model, inside), "错峰");
    assert.equal(promotionNote(model, outside), "错峰（未生效）");
    assert.equal(promotionWindow(model, outside), "00:00–08:00 / 22:00–24:00");
  },
);

test(
  "real Trae snapshot: a snapshot taken inside the window agrees with the window",
  { skip: !available ? "no local Trae snapshot" : false },
  () => {
    // `deepseek-v4.1-flash` 的 `current` 是 `off_peak`（抓于窗口内），
    // 与窗口推算必须**一致** —— 这是两条独立判据的交叉验证。
    const flash = snapshot.models.find((m) => m.id === "deepseek-v4.1-flash");
    assert.ok(flash, "fixture model missing");
    const features = flash.raw.features;
    assert.equal(features.activity_discount.data.current.discount_type, "off_peak");
    const offPeak = readOffPeakDiscount(asEntry(flash));
    assert.ok(offPeak);
    assert.equal(offPeak.timezone, "Asia/Shanghai");
    // 周六（2026-10-24）全天在窗口内。
    const saturday = new Date("2026-10-24T12:00:00+08:00");
    assert.equal(
      rateLabel({ creditsRate: features.consumption_rate.data.rate, offPeak }, saturday),
      "x0.12→x0.06",
    );
    // 工作日窗口实测是 00:00–09:00 / 12:00–14:00 / 18:00–24:00。
    // 周一 10:00 落在第一段之后、第二段之前 ⇒ 不在窗口内。
    const mondayMorning = new Date("2026-10-26T10:00:00+08:00");
    assert.equal(
      rateLabel({ creditsRate: features.consumption_rate.data.rate, offPeak }, mondayMorning),
      "x0.12",
    );
    // 周一 12:30 在第二段内 ⇒ 折后价（与 `current` 快照一致）。
    const mondayNoon = new Date("2026-10-26T12:30:00+08:00");
    assert.equal(
      rateLabel({ creditsRate: features.consumption_rate.data.rate, offPeak }, mondayNoon),
      "x0.12→x0.06",
    );
  },
);
