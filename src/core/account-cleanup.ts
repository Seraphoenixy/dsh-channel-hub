/**
 * 账号删除后的快照清理，以及「渠道未注册」账号的识别。
 *
 * ## 为什么需要这一步（真实遗留）
 *
 * `Pool.removeAccount()`（vendor 固定版本，`vendor/ofm/src/account-pool.ts`）
 * 只做两件事：注销凭据、把账号从数组里过滤掉。它**不碰** ledger 里的
 * per-account 快照，于是每删一个账号都会留下 3–4 个孤儿键，永久累积。
 *
 * 实测代价：一个 2026-10-20 建的探针账号（`zcode`，0 次推理）在驱动代码被删掉
 * 之后，账号行与 `catalog:` / `balance:` / `checkin:` 三个键在磁盘上又活了 26 小时。
 * 它既不在模型菜单里（`visible()` 按 driver 枚举），也不在 `channels.list` 里
 * （同样按 driver 枚举），所以**界面上完全看不见** —— 只能靠翻 `state.json` 发现。
 *
 * ## 键名清单：与写入方一一对应
 *
 * | 键 | 写入方 |
 * |---|---|
 * | `catalog:<provider>:<accountId>` | `drivers/ofm.js` 的 `catalog.refresh/load` |
 * | `balance:<accountId>` | `core/balance.ts` |
 * | `checkin:<accountId>` | `core/checkin.ts` |
 * | `identity:<provider>/<accountId>` | `storage/database.ts` 的 `begin()` |
 *
 * 新增第七类 per-account 快照时**必须**同步加一行（`tests/account-cleanup.test.ts`
 * 按这四条逐条核对，改漏了会红）。
 *
 * ## 刻意**不**清理的键
 *
 * `import:<source>:<legacyId>`（`migration.ts`）记的是「这个旧账号已经被导入过」，
 * 属于导入源的去重标记而不是新账号的快照。删掉新账号时保留它，才能避免
 * 「删掉 → 下次启动又被导入一次」的循环。
 *
 * ## 清理失败不能拖垮删号
 *
 * 删号本身是用户明确操作，必须成功返回；单个快照键删除失败只记一条 warn
 * （例如库被另一个连接锁住）。残留的孤儿键最坏结果就是回到这次要修的状态，
 * 不值得让「删号」这个动作失败。
 */

import type { Store } from "../storage/client.ts";
import { redact, type Account, type Logger } from "./types.ts";

/** 一个账号在 ledger 里的全部快照键（顺序即清理顺序，便于日志阅读）。 */
export function accountSnapshotKeys(account: {
  id: string;
  provider: string;
}): string[] {
  return [
    "catalog:" + account.provider + ":" + account.id,
    "balance:" + account.id,
    "checkin:" + account.id,
    "identity:" + account.provider + "/" + account.id,
  ];
}

/**
 * 删除一个账号的凭据，失败时**不抛错**。
 *
 * ## 为什么需要它（真实缺陷，「删除报错但又能删掉」）
 *
 * 旧实现写的是 `await credentials.delete?.(ref)`，而宿主 `ctx.credentials`
 * 的真实方法面只有 `resolve` / `describe` / `set` / `unset`（见
 * `@deepseek-ai/dsh-credentials-local`）—— **没有 `delete`，也没有 `remove`**。
 * 于是：
 *
 * - 可选调用 `?.` 只挡 `undefined`，挡不住「属性存在但是别的方法」这种情况；
 *   本插件的命名空间代理对 `delete` 也放行，返回一个转调
 *   `target['delete']` 的闭包，调用时抛
 *   `TypeError: target[key] is not a function`；
 * - 更糟的是这行位于 `pool.removeAccount()` **之后** —— 账号已经从池里消失，
 *   错误却让整个 RPC 返回失败。界面于是弹一条「操作未完成」，而账号确实没了：
 *   用户被同时告知「失败」与「成功」。
 * - 抛出还跳过了后面的 `purgeAccountSnapshots()`，于是磁盘上留下四个孤儿键
 *   （`catalog:` / `balance:` / `checkin:` / `identity:`），凭据本身也留在
 *   `.credentials.yaml` 里（实测某 profile 残留 7 份已删账号的凭据）。
 *
 * 因此这里按**真实 API** 调 `unset`，并保留 `delete` 作为旧宿主的兜底；
 * 两者都没有时静默跳过（该宿主没有凭据能力）。任何失败只记一条 warn ——
 * 删号已经完成，不能因为清理凭据回滚成「失败」。
 *
 * @returns 是否真的调用并成功了一个删除方法。
 */
export async function purgeAccountCredential(
  credentials: unknown,
  ref: string,
  logger?: Logger,
): Promise<boolean> {
  const service = credentials as Record<string, unknown> | undefined;
  if (service === undefined || service === null) return false;
  // 顺序：`unset` 是宿主当前 API；`delete` / `remove` 只作旧宿主兜底。
  // `TypeError` 表示「名字看起来在、其实不是这个服务的方法」（命名空间代理
  // 对未知方法也会返回闭包），此时继续试下一个名字，而不是当成清理失败。
  for (const name of ["unset", "delete", "remove"] as const) {
    const drop = service[name];
    if (typeof drop !== "function") continue;
    try {
      await (drop as (ref: string) => Promise<unknown>).call(service, ref);
      return true;
    } catch (error) {
      if (error instanceof TypeError) continue;
      logger?.warn("账号凭据清理失败（" + ref + "）：" + redact(error));
      return false;
    }
  }
  return false;
}

export interface PurgeResult {
  /** 成功删除的键。 */
  purged: string[];
  /** 删除失败的键与已脱敏的原因（不影响删号本身）。 */
  failed: Array<{ key: string; error: string }>;
}

/**
 * 删除一个账号的全部快照键。
 *
 * 幂等：键不存在时数据库返回 0 行，不视为失败。
 */
export async function purgeAccountSnapshots(
  store: Store,
  account: { id: string; provider: string },
  logger?: Logger,
): Promise<PurgeResult> {
  const purged: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of accountSnapshotKeys(account)) {
    try {
      await store.call("del", key);
      purged.push(key);
    } catch (error) {
      const message = redact(error);
      failed.push({ key, error: message });
      logger?.warn("账号快照清理失败（" + key + "）：" + message);
    }
  }
  return { purged, failed };
}

/**
 * 找出「渠道未注册」的账号。
 *
 * 判据是**驱动表**而不是任何静态渠道名单：驱动没了（渠道被移除、构建里缺了
 * 这个产品），这些账号就再也不可能被登录、续期、签到或推理，也不会出现在
 * `channels.list` 与模型菜单里 —— 正是「没删干净」的形态。
 *
 * 只报告、不自动删除：静默删掉用户数据比留一行孤儿更糟，而且将来某个构建把
 * 渠道装回来时，这些账号还能继续用。
 */
export function orphanAccounts(
  accounts: readonly Account[],
  providers: Iterable<string>,
): Account[] {
  const known = new Set(providers);
  return accounts.filter((a) => !known.has(a.provider));
}
