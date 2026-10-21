/**
 * 「这枚徽标该不该显示订阅」的判定表 —— **唯一一处**按渠道区分订阅形态的地方。
 *
 * ## 为什么集中在宿主侧
 *
 * 客户端（`plugin-src/client/badge-model.js`）只负责把已经判定好的读数渲染成
 * 一行文案。若把「哪个包算套餐」也写进 UI，规则就会有两份：宿主改了包名 /
 * 新增渠道时，界面会**静默**显示错的东西（把 `Bonus Pack` 当成订阅、或
 * 反过来永远不显示订阅），而单测只能锁住其中一份。
 *
 * ## 用户定的口径：窗口 > 套餐包 > 积分（2026-10-01）
 *
 * | provider | 订阅形态 | 判据 |
 * |---|---|---|
 * | `qoder` / `qodercn` | 套餐包 | 包名 === {@link QODER_PLAN_PACKAGE}（本仓库合成的固定名） |
 * | `buddy` / `workbuddy` | 套餐包 | 包名匹配 {@link PLAN_PACKAGE_PATTERN}（窄正则） |
 * | 其余 | 无 | 未登记即无 |
 *
 * ## ⚠️ 为什么 buddy 系只能靠**包名**判（并且正则必须窄）
 *
 * 两个 buddy 的资源包名由**服务端**下发，实测形态：
 * `Bonus Pack`（拉新权益，十几/几十天到期）、`Free Plan Subscription`（扣费截止
 * 在 8 年后）、`CodeBuddy个人体验版`、`国内运营裂变包`。其中只有带
 * Plan / Subscription / 体验版 的那类是「订阅套餐」。
 *
 * 正则**必须窄**，理由与本仓库 `looksLikeBillingError` 那条同源：泛词（`pack` /
 * `bonus` / `额度`）会把发放型权益错认成订阅，于是一个「只有一批月底作废的拉新
 * 积分」的账号会被显示成「有订阅」—— 比不显示订阅更糟。误判的兜底是用户把偏好
 * 切成「优先积分」（见 `badge-preferences.ts`），以及本文件的单测正反例。
 *
 * ## ⚠️ 为什么不登记 `codearts` / `trae` / `raccoon` 等
 *
 * - `codearts`：`packageName` / `specCode` 只是**套餐标识**（如
 *   `codearts.agent.enterprise.ultimate_pro`），没有独立的订阅额度读数 ——
 *   它的额度就是积分本身。
 * - `trae`：包名来自服务端 `display_desc`（如「资源包」），有效期规则是
 *   「起始 + 31 天」，属发放批次而非订阅窗口。
 * - `raccoon`：`会员积分` 是**会员权益发放**的积分池，不是订阅额度；把它当订阅
 *   会误导用户去核对一个并不存在的订阅。
 * - `loomy` / `lobsterai`：包是每日赠送 / 发放批次，不是订阅窗口。
 *
 * 一律**默认关闭**：将来新增渠道若忘记登记，最坏表现是「徽标显示积分」，
 * 而不是「显示一个不存在的订阅」。
 */

import type { CreditBalance } from './credits.js'
import { normalizeCreditUnit } from './credits.js'
import type { RpcUsageBadgePlanReading } from './types.js'
import { QODER_PLAN_PACKAGE } from './qoder-credits.js'

/**
 * 资源包名里出现这些词，即视为**订阅套餐**包。
 *
 * ⚠️ 窄正则，见文件头 `Bonus Pack` 的反例。大小写不敏感（服务端两种写法都有）。
 */
export const PLAN_PACKAGE_PATTERN = /plan|subscription|套餐|体验版/i

/** 某个渠道的套餐形态。 */
export type BadgePlanSelector =
  /** 余额里**某些包**是套餐（按包名挑）。 */
  { readonly kind: 'package'; readonly matches: (name: string) => boolean }

/** 包名匹配窄正则的渠道（两个 buddy 同源，共用一条规则）。 */
const planPackageSelector: BadgePlanSelector = Object.freeze({
  kind: 'package',
  matches: (name: string) => PLAN_PACKAGE_PATTERN.test(name),
})

/** 套餐包名等于固定字符串的渠道（Qoder 系的包名是本仓库自己合成的）。 */
const qoderPlanSelector: BadgePlanSelector = Object.freeze({
  kind: 'package',
  matches: (name: string) => name === QODER_PLAN_PACKAGE,
})

/**
 * 渠道 → 套餐形态。**未登记的渠道＝没有订阅**（默认关闭）。
 */
export const BADGE_PLAN_SELECTORS: Readonly<Record<string, BadgePlanSelector>> = Object.freeze({
  buddy: planPackageSelector,
  workbuddy: planPackageSelector,
  qoder: qoderPlanSelector,
  qodercn: qoderPlanSelector,
})

/** 该渠道的套餐形态；未登记返回 `undefined`（＝无订阅）。 */
export function badgePlanSelectorFor(provider: string): BadgePlanSelector | undefined {
  return BADGE_PLAN_SELECTORS[provider]
}

/**
 * 把余额折算成**一个**套餐读数（折叠态只显示一条）。
 *
 * 取舍：
 * - `kind: 'package'`：只取**仍然有效**（`active === true`）的匹配包中
 *   `remaining` 最大者。全部匹配包都已失效时返回 `null` → 徽标回落到积分
 *   （积分口径本来就不计失效包，两者自洽）。
 *
 * @param provider - 渠道 id。
 * @param balance - 该账号的余额（查不到时为 `null`）。
 * @returns 套餐读数；该渠道无订阅形态、余额查不到、无有效套餐包时为 `null`。
 */
export function badgePlanFor(provider: string, balance: CreditBalance | null): RpcUsageBadgePlanReading | null {
  if (balance === null) return null
  const selector = badgePlanSelectorFor(provider)
  if (selector === undefined) return null

  const matched = balance.packages
    .filter((pkg) => pkg.active === true && selector.matches(pkg.name))
    // 取剩余最大者：多套餐包（如「体验版」+「拉新订阅包」）时，用户关心的是
    // 还能用的那一份，而不是包名字典序最小的那一份。
    .sort((a, b) => b.remaining - a.remaining)
  const best = matched[0]
  if (best === undefined) return null
  return {
    name: best.name,
    remaining: best.remaining,
    total: best.total,
    // ⚠️ 下发前归一：包上的 `unit` 是服务端原值（实测同账号内 `credit` 与
    // `credits` 并存），原样下发会让客户端把同一份套餐拆成两组。见 `normalizeCreditUnit`。
    unit: normalizeCreditUnit(best.unit),
    ...best.deductionEndTime === undefined ? {} : { deductionEndTime: best.deductionEndTime },
  }
}

