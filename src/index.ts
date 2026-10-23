import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isReloading, selfReload, watchPackage } from "./reload.ts";
import { WorkerStore } from "./storage/client.ts";
import { CatalogService } from "./core/catalog.ts";
import { Observer } from "./core/observer.ts";
import { RenewalService } from "./core/renewal.ts";
import { BalanceService } from "./core/balance.ts";
import { CheckinService } from "./core/checkin.ts";
import { MigrationService } from "./migration.ts";
import { redact, type Account, type Filter } from "./core/types.ts";
import { creditReading } from "./core/credits.ts";
import {
  orphanAccounts,
  purgeAccountCredential,
  purgeAccountSnapshots,
} from "./core/account-cleanup.ts";
import { createDrivers } from "./drivers/ofm.js";
export const name = "channel-hub";
export const inject = ["llm", "credentials"];
export async function apply(ctx: any) {
  const profile = ctx.get?.("profileContext") ?? {};
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileName = profile.name ?? process.env.DSH_PROFILE ?? "desktop";
  if (!/^[\w.-]+$/.test(profileName)) throw Error("Invalid DSH profile name");
  const data = join(home, "profiles", profileName, "channel-hub");
  const namespace =
    "CHANNEL_HUB_" +
    createHash("sha256").update(data).digest("hex").slice(0, 12) +
    "_";
  /**
   * 凭据 ref 的命名空间代理。
   *
   * ## 为什么必须逐个列出方法名（真实缺陷）
   *
   * 宿主把每个插件的凭据 ref 加上 `CHANNEL_HUB_<hash>_` 前缀保存（同名 ref 在
   * 多个插件间才不会撞车），因此**每一个按 ref 读写的方法都必须加前缀**。
   * 旧实现只列了 `resolve` / `set` / `delete` / `remove` 四个，其中后两个在
   * 宿主 `ctx.credentials` 上**根本不存在**（真实方法面是 `resolve` /
   * `describe` / `set` / `unset`）。两个后果：
   *
   * 1. `delete` 不在服务上 → 删号时报 `TypeError: target[key] is not a function`，
   *    而账号已经被删掉，于是「报错 + 删除成功」同时发生；
   * 2. `unset` **没被列出** → 落到下面的兜底分支，`bind(target)` 后直接用
   *    **未加前缀**的 ref 调用，删的是 `ACCOUNT_x` 而非
   *    `CHANNEL_HUB_…_ACCOUNT_x`。宿主对不存在的键是 no-op，所以厂商
   *    `removeAccount()` 里的注销**一直在静默空转**，凭据永久留在
   *    `.credentials.yaml` 里（实测某 profile 残留 7 份已删账号的凭据）。
   *
   * 因此这里列全**按 ref 寻址**的方法：`resolve` / `describe` / `set` / `unset`。
   * 记录（record）那一组（`readRecord` / `modifyRecord` / `deleteRecord` …）
   * 以 `<scope>/<id>` 寻址，不走 ref，**不能**加这个前缀。
   *
   * @param ref 裸 ref（不带命名空间），由代理补上前缀。
   */
  const credentials = new Proxy(ctx.credentials, {
    get(target, key) {
      if (["resolve", "describe", "set", "unset", "delete", "remove"].includes(String(key)))
        return (ref: string, ...args: any[]) =>
          target[key](namespace + String(ref), ...args);
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scoped = new Proxy(ctx, {
    get(t, k) {
      if (k === "credentials") return credentials;
      if (k === "channelHubDataDir") return data;
      return Reflect.get(t, k, t);
    },
  });
  const store = new WorkerStore(join(data, "ledger.sqlite"));
  await store.ready;
  await store.call("prune");
  const catalog = new CatalogService(store);
  const observer = new Observer(store, ctx.logger);
  const engine = await createDrivers(scoped, { catalog, observer, store });
  const renewal = new RenewalService(
    () => engine.pool.listAllAccounts(),
    async (a: Account) => {
      const d = engine.drivers.get(a.provider);
      if (!d?.renew) throw Error("该渠道不支持自动续期");
      await d.renew(a);
    },
  );
  const migration = new MigrationService(
    home,
    ctx.credentials,
    credentials,
    engine.pool,
    store,
    profileName,
  );
  const balances = new BalanceService({
    accounts: () => engine.pool.listAllAccounts(),
    getAccount: (id) => engine.pool.findAccount(id),
    supports: (a) => !!engine.drivers.get(a.provider)?.balance,
    query: async (a) => {
      const d = engine.drivers.get(a.provider);
      if (!d?.balance) throw Error("此渠道不支持额度查询");
      // Early renewal belongs to the hourly scan. Balance polling only recovers
      // an already expired credential, sharing that account's renewal flight.
      if (a.refreshable && a.expiresAt !== undefined && a.expiresAt <= Date.now())
        await renewal.renew(a, false);
      return d.balance(engine.pool.findAccount(a.id) ?? a);
    },
    store, logger: ctx.logger,
  });
  const checkins = new CheckinService({
    accounts: () => engine.pool.listAllAccounts(),
    getAccount: (id) => engine.pool.findAccount(id),
    mode: (a) => !engine.drivers.get(a.provider)?.claim ? "unsupported" : "auto",
    claim: async (a) => {
      if (a.refreshable && a.expiresAt !== undefined && a.expiresAt <= Date.now())
        await renewal.renew(a, false);
      return engine.drivers.get(a.provider).claim(engine.pool.findAccount(a.id) ?? a);
    },
    afterClaim: (a) => balances.refresh(a),
    store, logger: ctx.logger,
  });
  let stopped = false;
  const reload = async () =>
    Promise.allSettled(
      [...engine.drivers.values()]
        .filter((d: any) => d.reload)
        .map((d: any) => d.reload()),
    );
  // Hydrate saved account directories before starting discovery. Do not publish static vendor tables.
  await engine.hydrate();
  // Accounts whose channel is not registered in this build are invisible everywhere:
  // `channels.list` and the model menu both enumerate drivers, and login / renew /
  // checkin / inference all resolve a driver first. Without this line the only way to
  // notice them is to open state.json (a leftover account lived 26h that way).
  const orphans = orphanAccounts(
    await engine.pool.listAllAccounts(),
    engine.drivers.keys(),
  );
  if (orphans.length > 0)
    ctx.logger?.warn?.(
      `渠道中心：${orphans.length} 个账号的渠道未注册（${[
        ...new Set(orphans.map((a: Account) => a.provider)),
      ].join("、")}），已跳过；可用 accounts.orphans 查看、accounts.delete 清理`,
    );
  void reload();
  renewal.start();
  balances.start();
  checkins.start();
  const timer = setInterval(() => {
    void reload();
    void store.call("prune").catch((e: unknown) => ctx.logger.warn(redact(e)));
  }, 1800000);
  timer.unref();
  const dispatch = async (method: string, p: any = {}) => {
    if (method === "channels.list") {
      const accounts = await engine.pool.listAllAccounts();
      return Promise.all(
        [...engine.drivers.values()].map(async (d: any) => ({
          id: d.id,
          name: d.name,
          error: d.error,
          canClaim: !!d.claim,
          canBalance: !!d.balance,
          canLogin: true,
          selectedAccountId: await engine.selection.get(d.id),
          accounts: await Promise.all(
            accounts
              .filter((a: Account) => a.provider === d.id)
              .map(async (a: Account) => {
                const balance = await store.call("get", "balance:" + a.id);
                return {
                  id: a.id,
                  provider: a.provider,
                  nickname: a.nickname,
                  enabled: a.enabled,
                  expiresAt: a.expiresAt,
                  refreshable: a.refreshable,
                  renewal: renewal.status(a.id),
                  checkin: await checkins.status(a),
                  // 归一化后的读数由宿主算好（见 core/credits.ts）：浏览器只画，
                  // 不判断「0 / 查不到 / 多单位」。
                  credits: creditReading(balance),
                  balance,
                  catalog: {
                    ...(await catalog.load(d.id + ":" + a.id)),
                    disabled: [...engine.pool.disabledModelsFor(d.id)],
                  },
                };
              }),
          ),
        })),
      );
    }
    if (method === "channels.selectAccount") {
      if (typeof p.provider !== "string" || !engine.drivers.has(p.provider))
        throw Error("Unknown channel");
      if (p.accountId !== null && (typeof p.accountId !== "string" || !p.accountId))
        throw Error("Invalid account selection");
      await engine.selection.set(p.provider, p.accountId);
      await engine.drivers.get(p.provider)?.hydrate?.();
      ctx.emit("llm/adapters-updated");
      return true;
    }
    if (method === "login.start") return engine.login(String(p.provider), p);
    if (method === "login.poll") {
      const s = engine.pending.get(p.token);
      return s ? { status: s.status, error: s.error, message: s.message } : { status: "expired", error: "授权会话已失效，请重新发起登录" };
    }
    if (method === "accounts.update") {
      const a = engine.pool.findAccount(p.id);
      if (!a) throw Error("Unknown account");
      await engine.pool.updateAccount(p.id, {
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(typeof p.nickname === "string"
          ? { nickname: p.nickname.slice(0, 100) }
          : {}),
      });
      ctx.emit("llm/adapters-updated");
      return true;
    }
    if (method === "accounts.delete") {
      const a = engine.pool.findAccount(String(p.id));
      if (!a) throw Error("Unknown account");
      // Snapshot purge belongs here, not in the pinned vendor pool: `removeAccount`
      // only unsets the credential and filters the array, leaving catalog / balance /
      // checkin / identity rows behind forever (see core/account-cleanup.ts).
      await engine.pool.removeAccount(a.id);
      // ⚠️ 必须用 `unset`（宿主真实 API），且必须在 `removeAccount` **之后**、
      // 且**不得抛错**：旧实现写 `credentials.delete?.()`，而宿主的
      // `ctx.credentials` 根本没有 `delete` —— 调用抛 TypeError，账号却已经
      // 从池里删掉了，于是「报错 + 删除成功」同时发生（真实缺陷）。抛错还
      // 跳过了下面的快照清理与凭据删除，留下孤儿键与残留凭据。
      await purgeAccountCredential(credentials, a.credentialRef, ctx.logger);
      catalog.forget(a.provider + ":" + a.id);
      await purgeAccountSnapshots(store, a, ctx.logger);
      ctx.emit("llm/adapters-updated");
      return true;
    }
    if (method === "accounts.orphans") {
      // Accounts whose provider has no driver in this build: invisible in
      // `channels.list` and the model menu, and impossible to use. Reported so they
      // can be inspected and deleted instead of lingering on disk unnoticed.
      return orphanAccounts(
        await engine.pool.listAllAccounts(),
        engine.drivers.keys(),
      ).map((a: Account) => ({
        id: a.id,
        provider: a.provider,
        nickname: a.nickname,
        enabled: a.enabled,
        createdAt: a.createdAt,
      }));
    }
    if (method === "accounts.balance" || method === "accounts.claim") {
      const a = engine.pool.findAccount(p.id);
      if (!a) throw Error("Unknown account");
      const d = engine.drivers.get(a.provider);
      const fn = method === "accounts.balance" ? d?.balance : d?.claim;
      if (!fn) throw Error("此渠道不支持该操作");
      if (method === "accounts.claim") return checkins.run(a, true);
      return balances.refresh(a);
    }

    if (method === "credits.refresh") {
      // 一次刷新多个账号（面板「刷新额度」按钮）。单个失败不中断其余账号，
      // 与 vendor 的 `collectCreditBalances` 同一取舍。
      const ids: string[] =
        Array.isArray(p.ids) && p.ids.length > 0
          ? p.ids.filter((id: unknown): id is string => typeof id === "string")
          : (await engine.pool.listAllAccounts())
              .filter((a: Account) =>
                p.provider ? a.provider === p.provider : true,
              )
              .map((a: Account) => a.id);
      const results = [];
      for (const id of [...new Set(ids)]) {
        const a = engine.pool.findAccount(id);
        if (!a) {
          results.push({ id, error: "Unknown account" });
          continue;
        }
        const d = engine.drivers.get(a.provider);
        if (!d?.balance) {
          results.push({ id, error: "此渠道不支持额度查询" });
          continue;
        }
        try {
          const result = await balances.refresh(a);
          results.push({ id, credits: result.credits });
        } catch (e) {
          results.push({
            id, error: redact(e),
            credits: creditReading(await store.call("get", "balance:" + a.id)),
          });
        }
      }
      return results;
    }
    if (method === "accounts.reorder") {
      if (
        !Array.isArray(p.ids) ||
        p.ids.some((id: unknown) => typeof id !== "string")
      )
        throw Error("Invalid account order");
      await engine.pool.reorderAccounts(String(p.provider), p.ids);
      return true;
    }
    if (method === "accounts.renew") {
      const a = engine.pool.findAccount(p.id);
      if (!a) throw Error("Unknown account");
      await renewal.renew(a);
      return true;
    }
    if (method === "models.refresh") {
      const d = engine.drivers.get(p.provider);
      if (!d?.reload) throw Error(d?.error ?? "Unknown channel");
      return d.reload();
    }
    if (method === "models.setDisabled") {
      if (typeof p.disabled !== "boolean")
        throw Error("disabled must be boolean");
      const provider = String(p.provider);
      if (p.all === true) {
        // 只支持「全部启用」：全部禁用必须点名当前目录的模型，
        // 否则会把从未见过的 id 写进黑名单（凭空扩大隐藏范围）。
        if (p.disabled) throw Error("all is only valid when enabling models");
        await engine.pool.clearDisabledModels(provider);
      } else if (Array.isArray(p.models)) {
        if (
          p.models.length === 0 ||
          p.models.some((id: unknown) => typeof id !== "string" || !id)
        )
          throw Error("models must be a non-empty string array");
        const ids = [...new Set(p.models.map(String))];
        if (p.disabled) await engine.pool.setModelsDisabled(provider, ids);
        else await engine.pool.clearModelsDisabled(provider, ids);
      } else {
        if (typeof p.model !== "string" || !p.model)
          throw Error("model must be a non-empty string");
        await engine.pool.setModelDisabled(provider, p.model, p.disabled);
      }
      ctx.emit("llm/adapters-updated");
      return true;
    }
    if (
      method === "usage.summary" ||
      method === "usage.series" ||
      method === "usage.accounts" ||
      method === "usage.models"
    )
      return store.call("stats", validateFilter(p));
    if (method === "requests.list")
      return store.call("list", validateFilter(p));
    if (method === "requests.detail") return store.call("detail", String(p.id));
    if (method === "health") return observer.health;
    if (method === "migration.preview") return migration.preview();
    if (method === "migration.import") {
      if (p.confirm !== true)
        throw Error("Explicit import confirmation required");
      const result = await migration.importAll(
        new Set([...engine.drivers.keys()]),
      );
      await reload();
      ctx.emit("llm/adapters-updated");
      return result;
    }
    throw Error("Unknown channel-hub method: " + method);
  };
  const mount = () => {
    const connection = ctx.get?.("connection");
    if (!connection?.fetch?.register) return;
    return connection.fetch.register({
      path: "/api/channel-hub",
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request: Request) {
        let rpcId = "invalid";
        try {
          if (request.method !== "POST")
            return new Response("method not allowed", { status: 405 });
          if (
            request.headers.get("content-type")?.split(";")[0] !==
            "application/json"
          )
            return new Response("JSON required", { status: 415 });
          const m = (await request.json()) as any;
          rpcId = m.rpcId;
          if (
            m.type !== "client-request" ||
            m.method !== "channel-hub" ||
            typeof rpcId !== "string" ||
            m.payload?.version !== 1 ||
            typeof m.payload?.method !== "string"
          )
            throw Error("Invalid versioned RPC envelope");
          const value = await dispatch(m.payload.method, m.payload.payload);
          return Response.json({
            type: "server-response",
            rpcId,
            result: { ok: true, value },
          });
        } catch (e) {
          return Response.json({
            type: "server-response",
            rpcId,
            result: {
              ok: false,
              error: {
                code: "channel-hub/error",
                message: redact(e),
                details: {},
              },
            },
          });
        }
      },
    });
  };
  if (ctx.inject) ctx.inject(["connection"], mount);
  else mount();
  // Development hot reload. Only a checkout has src/index.ts; an installed
  // tarball contains dist/ and docs, so this branch stays inert in production.
  // The kernel's HMR service has no "reload now" API, so the plugin mirrors
  // partialReload itself (see src/reload.ts). Disable with
  // CHANNEL_HUB_HOT_RELOAD=0 if a long-running session must stay pinned.
  let stopWatch: (() => void) | undefined;
  const packageDir = fileURLToPath(new URL("../", import.meta.url));
  if (
    process.env.CHANNEL_HUB_HOT_RELOAD !== "0" &&
    existsSync(join(packageDir, "src", "index.ts"))
  ) {
    const distDir = join(packageDir, "dist");
    // A build can finish while the previous swap is still tearing down its
    // worker; remember it and reload again once the current swap settles.
    let reloadQueued = false;
    const reloadFromDisk = (): void => {
      if (stopped) return;
      if (isReloading()) {
        reloadQueued = true;
        return;
      }
      ctx.logger?.info?.("channel-hub: dist 已更新，正在热重载插件");
      void selfReload(ctx, {
        logger: ctx.logger,
        packageUrl: new URL("../", import.meta.url).href,
        entryUrl: import.meta.url,
        activity: {
          isIdle: () => observer.isIdle() && engine.loginsIdle(),
          whenIdle: async () => { await observer.whenIdle(); await engine.waitForLogins(); },
        },
      })
        .then((result) => {
          if (result.ok)
            ctx.logger?.info?.(
              `channel-hub: 热重载完成（${result.fibers} 个 fiber）`,
            );
          else
            ctx.logger?.warn?.(`channel-hub: 热重载失败：${result.error}`);
        })
        .catch((error: any) =>
          ctx.logger?.warn?.(
            `channel-hub: 热重载异常：${error?.message ?? error}`,
          ),
        )
        .finally(() => {
          if (!reloadQueued) return;
          reloadQueued = false;
          reloadFromDisk();
        });
    };
    stopWatch = watchPackage(distDir, {
      logger: ctx.logger,
      filter: (file) => {
        const normalized = file.replaceAll("\\", "/");
        return (
          normalized === "index.js" ||
          normalized === "ledger-worker.js" ||
          normalized.endsWith("/index.js") ||
          normalized.endsWith("/ledger-worker.js")
        );
      },
      onChange: reloadFromDisk,
    });
    if (typeof ctx.effect === "function") ctx.effect(() => stopWatch);
    ctx.logger?.info?.("channel-hub: 开发检出模式，已启用 dist 热重载");
  }
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopWatch?.();
    stopWatch = undefined;
    clearInterval(timer);
    const checkinsStopped = checkins.stop();
    const pollingStopped = Promise.all([renewal.stop(), checkinsStopped.then(() => balances.stop())]);
    await observer.close();
    await pollingStopped;
    await engine.stop();
    await store.close();
  };
  return Object.assign(stop, { dispatch, stop });
}
export function validateFilter(p: any): Filter {
  const out: Filter = {};
  for (const k of ["provider", "accountId", "model", "outcome"] as const)
    if (typeof p[k] === "string") out[k] = p[k].slice(0, 200) as any;
  for (const k of ["from", "to", "page", "limit"] as const)
    if (p[k] !== undefined) {
      if (!Number.isSafeInteger(p[k]) || p[k] < 0) throw Error("Invalid " + k);
      out[k] = p[k];
    }
  return out;
}
