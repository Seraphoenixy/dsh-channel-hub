/**
 * Development hot reload: replace the running plugin with the code now on disk,
 * without restarting DSH.
 *
 * The kernel's HMR service reloads plugins by watching files, but it ships with
 * module watching off and exposes no "reload this plugin now" call. Its
 * `partialReload` does define the correct sequence, and this module mirrors it
 * against the same primitives:
 *
 * 1. snapshot the live fibers and their configs;
 * 2. back the package's entries out of Node's ESM `loadCache` and the CJS
 *    `require.cache` (`Map.prototype` methods are used where the cache really
 *    is a Map; Node 24's LoadCache subclass only clears a type slot on
 *    `.delete`);
 * 3. re-import the entry through the kernel loader so the new sources evaluate;
 * 4. dispose the old fibers, register the replacement under the same config,
 *    and re-attach the loader entry so config writes keep landing on the live
 *    fiber;
 * 5. on any failure, restore both caches and the previous registration. A
 *    failed restore is reported as a failure, not as availability.
 *
 * This is a development aid, not a production update path: only the `dist/`
 * output of a checkout is watched, and an ordinary tarball install does not
 * contain `src/index.ts`, so the watcher stays off there.
 *
 * Adapted from `dsh-our-free-model/src/reload.js` (MIT); the import and its
 * local changes are described in `docs/ARCHITECTURE.md`.
 *
 * @module src/reload.ts
 */

import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type ReloadResult =
  | { ok: true; version: string; fibers: number }
  | { ok: false; error: string; restored: boolean };

type CacheBackup = {
  esm: Map<string, unknown>;
  cjs: Map<string, unknown>;
};

let inFlight: Promise<ReloadResult> | null = null;

const HOOKS_KEY = Symbol.for("channel-hub.reload-hooks");
const reloadHooks: Map<string, unknown> = ((globalThis as any)[HOOKS_KEY] ??=
  new Map());

/** Normalize a URL/path for the case- and separator-insensitive comparisons
 *  Node's resolver and `new URL` can disagree about on Windows. */
function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Carry the entry's generation query into its dependencies when a kernel hides
 *  its module cache and a fresh URL is the only way to re-evaluate the entry. */
function enableFreshDependencies(packageUrl: string): void {
  if (reloadHooks.has(packageUrl)) return;
  const packagePath = normalizePath(fs.realpathSync(fileURLToPath(packageUrl)));
  const hook = registerHooks({
    resolve(specifier: string, context: any, nextResolve: any) {
      const resolved = nextResolve(specifier, context);
      if (
        !context.parentURL?.startsWith("file:") ||
        !resolved.url.startsWith("file:")
      )
        return resolved;
      const parentPath = normalizePath(
        fs.realpathSync(fileURLToPath(new URL(context.parentURL))),
      );
      const resolvedPath = normalizePath(
        fs.realpathSync(fileURLToPath(new URL(resolved.url))),
      );
      if (
        !parentPath.startsWith(packagePath + "/") ||
        !resolvedPath.startsWith(packagePath + "/")
      )
        return resolved;
      const generation = new URL(context.parentURL).searchParams.get(
        "channel-hub-reload",
      );
      if (generation === null) return resolved;
      const target = new URL(resolved.url);
      target.searchParams.set("channel-hub-reload", generation);
      return { ...resolved, url: target.href };
    },
  });
  reloadHooks.set(packageUrl, hook);
}

/** Whether a reload is currently running; guards overlapping swaps. */
export function isReloading(): boolean {
  return inFlight !== null;
}

/** Every loadCache key that lives inside the package. */
export function packageCacheKeys(
  loadCache: any,
  packageUrl: string,
): string[] {
  const base = normalizePath(decodeURIComponent(packageUrl)) + "/";
  const keys: string[] = [];
  for (const key of loadCache.keys()) {
    if (typeof key !== "string") continue;
    let normalized: string;
    try {
      normalized = normalizePath(decodeURIComponent(key));
    } catch {
      normalized = normalizePath(key);
    }
    if (normalized.startsWith(base)) keys.push(key);
  }
  return keys;
}

/**
 * Back up and remove the package's modules from both module caches.
 *
 * The loadCache is duck-typed on purpose: Node 24.12+ replaced the Map subclass
 * with its own structure, so `instanceof Map` is false on newer runtimes even
 * though `keys/get/delete` still behave like a map.
 */
export function purgeCaches(
  internal: any,
  packageUrl: string,
): CacheBackup {
  const backup: CacheBackup = { esm: new Map(), cjs: new Map() };
  const cache = internal?.loadCache;
  if (
    cache !== null &&
    cache !== undefined &&
    typeof cache.keys === "function" &&
    typeof cache.get === "function" &&
    typeof cache.delete === "function"
  ) {
    const read = (key: string) => {
      try {
        return Map.prototype.get.call(cache, key);
      } catch {
        try {
          return cache.get(key);
        } catch {
          return undefined;
        }
      }
    };
    const drop = (key: string) => {
      try {
        Map.prototype.delete.call(cache, key);
        return;
      } catch {
        /* not a real Map — fall through */
      }
      try {
        cache.delete(key);
      } catch {
        /* best effort */
      }
    };
    for (const key of packageCacheKeys(cache, packageUrl)) {
      backup.esm.set(key, read(key));
      drop(key);
    }
  }
  const require = createRequire(import.meta.url);
  for (const key of backup.esm.keys()) {
    try {
      const filePath = fileURLToPath(key);
      if (require.cache[filePath] !== undefined) {
        backup.cjs.set(filePath, require.cache[filePath]);
        delete require.cache[filePath];
      }
    } catch {
      // non-file: URL — nothing to purge on the CJS side
    }
  }
  return backup;
}

/** Put a purge's backup back (rollback path). */
export function restoreCaches(internal: any, backup: CacheBackup): void {
  const cache = internal?.loadCache;
  for (const [key, job] of backup.esm) {
    try {
      Map.prototype.set.call(cache, key, job);
    } catch {
      try {
        cache.set(key, job);
      } catch {
        /* best effort */
      }
    }
  }
  const require = createRequire(import.meta.url);
  for (const [filePath, module] of backup.cjs)
    require.cache[filePath] = module as NodeModule;
}

/**
 * Reload the calling plugin instance in place.
 *
 * Called from a plain file-watch callback, outside the fiber being disposed, so
 * disposal of the caller's own effects cannot cancel the swap mid-way.
 */
export function selfReload(
  ctx: any,
  options: {
    logger?: Logger;
    packageUrl?: string;
    entryUrl?: string;
    expectedVersion?: string;
    activity?: { isIdle(): boolean; whenIdle(): Promise<void> };
  } = {},
): Promise<ReloadResult> {
  if (inFlight !== null) return inFlight;
  const running = (async (): Promise<ReloadResult> => {
    const logger = options.logger ?? console;
    const packageUrl =
      options.packageUrl ?? new URL("../", import.meta.url).href;
    const entryUrl = options.entryUrl ?? import.meta.url;
    const loader = ctx.loader;
    const registry = ctx.registry;
    if (loader === undefined || registry === undefined)
      return { ok: false, error: "no loader/registry on this context", restored: false };

    // The plugin identity is the exports object the registry keyed the runtime by.
    const previous = ctx.fiber?.runtime?.callback;
    if (previous === undefined || previous === null)
      return {
        ok: false,
        error: "no runtime to reload (plugin was not registered the ordinary way)",
        restored: false,
      };
    const runtime = registry.get(previous);
    const fibers = [...(runtime?.fibers ?? [])].map((fiber: any) => {
      const entry =
        fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
      const plugin =
        typeof previous === "function"
          ? {
              apply: previous,
              inject: { ...fiber.inject },
              Config: runtime.Config,
              name: runtime.name,
            }
          : previous;
      return {
        fiber,
        entry,
        plugin,
        config: entry === undefined ? fiber._config : entry.options.config,
      };
    });
    if (fibers.length === 0)
      return { ok: false, error: "runtime has no live fibers", restored: false };

    // Import only after in-flight inference has drained. close() deliberately
    // aborts on real shutdown; an automatic build must not use that as its
    // way of getting rid of live requests.
    while (options.activity && !options.activity.isIdle())
      await options.activity.whenIdle();
    const internal = loader.internal;
    const backup = purgeCaches(internal, packageUrl);
    logger.info?.(
      `channel-hub: hot reload purging ${backup.esm.size} cached module(s)`,
    );

    const importFresh = async (url: string) =>
      loader.unwrapExports(await loader.import(url, () => []));
    let replacement: any;
    let busted = false;
    try {
      replacement = await importFresh(entryUrl);
      if (replacement === undefined || typeof replacement.apply !== "function")
        throw new Error("reloaded module does not export apply()");
      if (
        backup.esm.size === 0 ||
        replacement === previous ||
        replacement.apply === previous ||
        (typeof previous.apply === "function" &&
          replacement.apply === previous.apply)
      ) {
        // The cache purge did not take effect on this kernel (the loadCache
        // shape changes across Node versions). Force a fresh evaluation of the
        // entry with a generation query shared by static and lazy dependencies.
        enableFreshDependencies(packageUrl);
        const freshUrl = new URL(entryUrl);
        freshUrl.searchParams.set(
          "channel-hub-reload",
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        replacement = await importFresh(freshUrl.href);
        busted = true;
        if (replacement === undefined || typeof replacement.apply !== "function")
          throw new Error("reloaded module does not export apply()");
        if (
          replacement === previous ||
          replacement.apply === previous ||
          (typeof previous.apply === "function" &&
            replacement.apply === previous.apply)
        )
          throw new Error(
            "replacement is still the previous plugin after cache invalidation",
          );
      }
      if (
        options.expectedVersion !== undefined &&
        replacement.version !== options.expectedVersion
      )
        throw new Error(
          `activation version mismatch: expected ${options.expectedVersion}, got ${String(replacement.version ?? "(missing)")}`,
        );
    } catch (error: any) {
      restoreCaches(internal, backup);
      return {
        ok: false,
        error: `re-import failed, old code still running (${error?.message ?? error})`,
        restored: true,
      };
    }
    (globalThis as any)[Symbol.for("channel-hub.last-reload")] = {
      at: Date.now(),
      purged: backup.esm.size,
      busted,
    };

    try {
      // Import is asynchronous: a request may have started during it. Recheck
      // immediately before the synchronous disposal boundary, without an await
      // between the final idle check and registry.delete().
      while (options.activity && !options.activity.isIdle())
        await options.activity.whenIdle();
      registry.delete(previous);
      await Promise.all(fibers.map(({ fiber }: any) => fiber.await()));
    } catch (error: any) {
      // Old fibers are gone regardless; the new registration below is still the
      // right move — the error is logged, not propagated, to not skip it.
      logger.warn?.(
        `channel-hub: hot reload dispose reported ${error?.message ?? error}`,
      );
    }

    try {
      const created: any[] = [];
      for (const { fiber, entry, config } of fibers) {
        const registered = fiber.parent.registry.plugin(replacement, config);
        const fresh = registered.ctx.fiber;
        if (entry !== undefined) {
          fresh.entry = entry;
          entry.fiber = fresh;
        }
        created.push(fresh);
      }
      await Promise.all(created.map((fiber) => fiber.await()));
      logger.info?.(
        `channel-hub: hot reload complete, ${created.length} fiber(s) re-registered`,
      );
      return {
        ok: true,
        version: String(replacement.version ?? ""),
        fibers: created.length,
      };
    } catch (error: any) {
      // The replacement failed to start. Put the old code back in the registry;
      // the caller's files are untouched, so the old code is still on disk too.
      restoreCaches(internal, backup);
      try {
        registry.delete(replacement);
      } catch {
        /* may never have started */
      }
      try {
        const restored: any[] = [];
        for (const { fiber, entry, plugin, config } of fibers) {
          const registered = fiber.parent.registry.plugin(plugin, config);
          const fresh = registered.ctx.fiber;
          if (entry !== undefined) {
            fresh.entry = entry;
            entry.fiber = fresh;
          }
          restored.push(fresh);
        }
        await Promise.all(restored.map((fiber) => fiber.await()));
        return {
          ok: false,
          error: `new code failed to start, previous version restored (${error?.message ?? error})`,
          restored: true,
        };
      } catch (restoreError: any) {
        return {
          ok: false,
          error: `new code failed to start (${error?.message ?? error}); runtime restore failed too (${restoreError?.message ?? restoreError})`,
          restored: false,
        };
      }
    }
  })();
  inFlight = running;
  return running.finally(() => {
    inFlight = null;
  });
}

/**
 * Watch a package directory and debounce file changes into one callback.
 *
 * The watcher is `unref()`ed so an idle desktop process can still exit and a
 * host test does not hang. Returns a stop function; calling it twice is safe.
 */
export function watchPackage(
  packageDir: string,
  {
    onChange,
    logger = console,
    debounceMs = 700,
    filter,
  }: {
    onChange?: () => void;
    logger?: Logger;
    debounceMs?: number;
    filter?: (filename: string) => boolean;
  } = {},
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let paused = false;
  let watcher: fs.FSWatcher;
  // A linked install (the desktop profile uses a Windows junction) must be
  // watched through its real target: fs.watch on the junction itself does not
  // report writes made through the other path.
  let watchDir = packageDir;
  try {
    watchDir = fs.realpathSync(packageDir);
  } catch {
    /* keep the supplied path if it cannot be resolved */
  }
  try {
    watcher = fs.watch(watchDir, { recursive: true });
  } catch (error: any) {
    logger.warn?.(
      `channel-hub: could not watch ${watchDir} (${error?.message ?? error})`,
    );
    return () => {};
  }
  const schedule = (_event: string, filename: string | null) => {
    if (paused) return;
    if (filename !== null && filter !== undefined && !filter(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!paused) onChange?.();
    }, debounceMs);
    timer.unref?.();
  };
  watcher.on("change", schedule);
  watcher.on("rename", schedule);
  watcher.on("error", (error: any) =>
    logger.warn?.(`channel-hub: watcher error (${error?.message ?? error})`),
  );
  watcher.unref?.();
  return () => {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  };
}
