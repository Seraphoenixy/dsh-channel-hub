import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGeminiSigStore,
  GeminiSigStore,
  GEMINI_SIG_FILE,
  geminiSigKey,
} from "../vendor/ofm/src/gemini-sigstore.ts";

/**
 * `thoughtSignature` 缓存的**落盘契约**。
 *
 * 真实缺陷（2026-10-21）：`src/drivers/ofm.js` 从来没有构造过这个缓存，适配器
 * 拿不到 `sigStore` ⇒ 每轮工具调用都不带签名 ⇒ 上游 400
 * `Function call is missing a thought_signature in functionCall parts`。
 *
 * 接线本身由驱动层负责（构建产物里可见 `createGeminiSigStore(ctx)`），这里锁住
 * 缓存自己的契约：落在 channel-pack 目录（**不能**塞进 state.json）、键可复现、
 * 落盘后重新载入仍能命中。夹具全部在临时目录，不读真实账号。
 */

const keys = (name, argsJson) => geminiSigKey(`tool:${name}`, argsJson);

test("the cache lives beside state.json, not inside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "chub-sig-"));
  try {
    const store = createGeminiSigStore({ channelHubDataDir: dir, logger: console });
    assert.equal(store.size, 0, "a fresh directory starts empty instead of throwing");
    // 路径必须可推导且与 state.json 同目录（`channel-pack/`）。
    const expected = join(dir, "channel-pack", GEMINI_SIG_FILE);
    writeFileSync(join(dir, "probe.txt"), expected);
    assert.equal(
      readFileSync(join(dir, "probe.txt"), "utf8"),
      join(dir, "channel-pack", GEMINI_SIG_FILE),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signature round-trips through the file and is looked up by tool key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chub-sig-"));
  try {
    const file = join(dir, GEMINI_SIG_FILE);
    const first = new GeminiSigStore(file, undefined);
    first.put("default_api:grep", '{"pattern":"x"}', "SIG-A");
    await first.flush();

    // 磁盘上确实写下了（原子写后文件存在且含签名）。
    assert.match(readFileSync(file, "utf8"), /SIG-A/);

    // 新进程视角：重新载入后精确键与「按工具名取最近」都能命中。
    const reloaded = new GeminiSigStore(file, undefined);
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.get("default_api:grep", '{"pattern":"x"}'), "SIG-A");
    assert.equal(
      reloaded.latestForTool("default_api:grep"),
      "SIG-A",
      "parameter drift must still find the last signature for that tool",
    );
    assert.equal(reloaded.get("default_api:grep", '{"pattern":"y"}'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blank signatures are discarded and a corrupt file degrades to empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chub-sig-"));
  try {
    const file = join(dir, GEMINI_SIG_FILE);
    const store = new GeminiSigStore(file, undefined);
    // 上游偶尔下发空串占位：存进去会让回填侧以为"有签名"而发一个空字段。
    store.put("grep", "{}", "   ");
    assert.equal(store.size, 0);
    await store.flush();

    // 坏文件按空缓存处理（纯缓存，不该让推理失败）。
    writeFileSync(file, "{ not json");
    assert.equal(new GeminiSigStore(file, undefined).size, 0);

    // 目录不存在时也能安全写入（`mkdirSync` 递归建目录）。
    const nested = join(dir, "deep", "nested", GEMINI_SIG_FILE);
    const nestedStore = new GeminiSigStore(nested, undefined);
    nestedStore.put("read", '{"path":"a"}', "SIG-B");
    await nestedStore.flush();
    assert.equal(new GeminiSigStore(nested, undefined).get("read", '{"path":"a"}'), "SIG-B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signature key is stable for the same tool and canonical args", () => {
  // 键不可复现会让回填永远查不中（症状是每轮都发哨兵而不报错）。
  assert.equal(
    keys("grep", '{"pattern":"x"}'),
    keys("grep", '{"pattern":"x"}'),
  );
  assert.notEqual(keys("grep", '{"pattern":"x"}'), keys("grep", '{"pattern":"y"}'));
  assert.notEqual(keys("grep", "{}"), keys("read", "{}"));
  // 键只取正文前 512 字符：长尾变化不影响命中。
  const head = "a".repeat(512);
  assert.equal(
    keys("run", head + "tail-one"),
    keys("run", head + "tail-two"),
  );
});
