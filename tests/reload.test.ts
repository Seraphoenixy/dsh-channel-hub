import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  isReloading,
  packageCacheKeys,
  purgeCaches,
  restoreCaches,
  selfReload,
  watchPackage,
} from "../src/reload.ts";
import { isWatchedArtifact } from "../src/index.ts";

test("hot reload waits for inference before import and rechecks before disposal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-hub-drain-"));
  const url = pathToFileURL(join(dir, "index.js")).href;
  const previous = { apply() {} };
  const replacement = { apply() {} };
  let idle = false;
  let release!: () => void;
  let waiting!: () => void;
  let waited = new Promise<void>((r) => { waiting = r; });
  let imports = 0;
  let disposals = 0;
  const fresh = { async await() {} };
  const fiber = { parent: { registry: { plugin: () => ({ ctx: { fiber: fresh } }) } }, async await() {} };
  const ctx = {
    fiber: { runtime: { callback: previous } },
    registry: {
      get: () => ({ fibers: [fiber] }),
      delete() { assert.equal(idle, true); disposals++; },
    },
    loader: {
      internal: { loadCache: new Map([[url, {}]]) },
      unwrapExports: (value: unknown) => value,
      async import() {
        imports++;
        assert.equal(idle, true);
        // A second inference begins during the asynchronous module import.
        idle = false;
        waited = new Promise<void>((r) => { waiting = r; });
        return replacement;
      },
    },
  };
  try {
    const result = selfReload(ctx, {
      packageUrl: pathToFileURL(dir).href,
      entryUrl: url,
      logger: { info() {}, warn() {} },
      activity: {
        isIdle: () => idle,
        whenIdle: () => new Promise<void>((r) => { release = r; waiting(); }),
      },
    });
    await waited;
    assert.equal(imports, 0);
    assert.equal(disposals, 0);
    idle = true;
    release();
    // Let import replace the second gate before waiting for that gate.
    await Promise.resolve();
    await waited;
    assert.equal(imports, 1);
    assert.equal(disposals, 0);
    idle = true;
    release();
    assert.equal((await result).ok, true);
    assert.equal(disposals, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packageCacheKeys selects only modules inside the package", () => {
  const cache = new Map<string, unknown>([
    ["file:///D:/pkg/dist/index.js", { module: 1 }],
    ["file:///D:/pkg/dist/index.js?channel-hub-reload=1", { module: 2 }],
    ["file:///D:/pkg-other/dist/index.js", { module: 3 }],
    ["node:fs", {}],
  ]);
  assert.deepEqual(
    packageCacheKeys(cache, "file:///D:/pkg").sort(),
    [
      "file:///D:/pkg/dist/index.js",
      "file:///D:/pkg/dist/index.js?channel-hub-reload=1",
    ].sort(),
  );
});

test("purgeCaches removes both caches and restoreCaches puts them back", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-hub-reload-"));
  const file = join(dir, "fixture.cjs");
  writeFileSync(file, "module.exports = { value: 1 };\n");
  const require = createRequire(import.meta.url);
  const loaded = require(file);
  const cached = require.cache[file];
  const url = pathToFileURL(file).href;
  const cache = new Map<string, unknown>([[url, { module: "job" }]]);
  const internal = { loadCache: cache };
  try {
    const backup = purgeCaches(internal, pathToFileURL(dir).href);
    assert.equal(cache.size, 0);
    assert.equal(require.cache[file], undefined);
    restoreCaches(internal, backup);
    assert.deepEqual(cache.get(url), { module: "job" });
    assert.equal(require.cache[file], cached);
    assert.equal(loaded.value, 1);
    assert.equal(isReloading(), false);
  } finally {
    delete require.cache[file];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchPackage observes filtered dist changes and stops", async () => {  const dir = mkdtempSync(join(tmpdir(), "channel-hub-watch-"));
  const dist = join(dir, "dist");
  mkdirSync(dist);
  let resolveChanged: () => void = () => {};
  let rejectChanged: (error: Error) => void = () => {};
  const changed = new Promise<void>((resolve, reject) => {
    resolveChanged = resolve;
    rejectChanged = reject;
  });
  let calls = 0;
  const stop = watchPackage(dir, {
    debounceMs: 50,
    // 用**真实**的过滤器，不是复刻一份：内联复刻会与 src 里的实现各自漂移。
    filter: isWatchedArtifact,
    onChange: () => {
      calls += 1;
      resolveChanged();
    },
  });
  const timeout = setTimeout(
    () => rejectChanged(new Error("watchPackage did not report a build")),
    3000,
  );
  timeout.unref?.();
  try {
    // 界面产物的变化必须算一次构建（这正是被漏掉的那一类）。
    writeFileSync(join(dist, "client.js"), "changed\n");
    await changed;
    assert.equal(calls, 1);
  } finally {
    clearTimeout(timeout);
    stop();
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "watchPackage follows a Windows junction to the real package",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "channel-hub-junction-"));
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(join(target, "dist"), { recursive: true });
    symlinkSync(target, link, "junction");
    let calls = 0;
    let resolveChanged: () => void = () => {};
    let rejectChanged: (error: Error) => void = () => {};
    const changed = new Promise<void>((resolve, reject) => {
      resolveChanged = resolve;
      rejectChanged = reject;
    });
    const stop = watchPackage(link, {
      debounceMs: 50,
      filter: (file) => file.replaceAll("\\", "/").endsWith("dist/index.js"),
      onChange: () => {
        calls += 1;
        resolveChanged();
      },
    });
    const timeout = setTimeout(
      () => rejectChanged(new Error("junction watch did not report a build")),
      3000,
    );
    timeout.unref?.();
    try {
      writeFileSync(join(target, "dist", "index.js"), "changed\n");
      await changed;
      assert.equal(calls, 1);
    } finally {
      clearTimeout(timeout);
      stop();
      stop();
      try {
        unlinkSync(link);
      } catch {
        /* already removed */
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the watch filter covers client.js, not just the server bundle", () => {
  // 2026-10-29：「只改界面」的构建原先不触发任何重载通知 —— 过滤器只认
  // `index.js` / `ledger-worker.js`，`client.js` 被漏掉。后果是排查「改完了
  // 但没生效」时，日志里连一条「dist 已更新」都没有。
  //
  // 浏览器侧的样式与组件只来自 `client.js`（宿主按请求从磁盘读，响应
  // `no-store`），所以它必须在监视列表里。
  for (const name of ["index.js", "ledger-worker.js", "client.js"]) {
    assert.equal(isWatchedArtifact(name), true, "bare name: " + name);
    assert.equal(
      isWatchedArtifact("D:/project/dsh-channel-hub/dist/" + name),
      true,
      "absolute path: " + name,
    );
    assert.equal(
      isWatchedArtifact("dist\\" + name),
      true,
      "windows relative path: " + name,
    );
  }
  // 不相关产物不得触发重载：否则一次构建会连着重载好几次。
  for (const name of ["qoder-auth-wasm.wasm", "index.js.map", "client.js.map"])
    assert.equal(isWatchedArtifact(name), false, "must be ignored: " + name);
});
