# 架构与维护边界

## 模块

- `src/index.ts`：DSH 生命周期、profile 路径、凭据引用命名空间、鉴权连接中的版本化 RPC。
- `src/drivers/`：OFM 认证/账号池与各渠道驱动的装配；Gemini 动态发现补充。Gemini 额外接线 `gemini-sigstore`：`thoughtSignature` 缓存按渠道建一次并长期复用、停止时落盘（不接则每轮工具调用都无签名，上游 400）；项目号探测缓存同理。
- `src/core/`：请求上下文、物理尝试、统一指标、目录快照与续期调度；`rate.ts` 做各驱动计费系数的展示归一化，**并统一按「窗口 + 当前时刻」推算折扣是否生效**（见下）；`context.ts` 只做**上下文档位**的展示归一化（`contextWindow` 与另一档 `maxContextWindow`，相等不算两档，缺失不补值），供模型菜单后缀与渠道中心徽标共用；`promotion.ts` 在**已有的** `/v3/config` 响应上补出折扣时段与角标（不新增端点，vendor 快照哈希不变）；`credits.ts` 把各渠道额度响应归一成 `{ label, progress, packages, error }` 的展示读数（读数文案在宿主拼好，浏览器只画；查不到不显示成 0，token 与积分不合并，面值未知不补 100%，全零占位包不否决同账号其它包的面值）。
- `src/storage/`：数据库工作线程；请求明细与日汇总在同一事务终结。
- `src/migration.ts`：只读旧数据、格式转换、幂等导入与模型偏好合并。
- `src/reload.ts`：仅开发检出的模块缓存清理、原位重载与目录监视；不改变 RPC 或安装布局。
- `src/client.ts`：构建为唯一浏览器入口，渠道、看板、日志三个页面；**样式在独立的 `src/client.css`**，由 esbuild 的 `text` loader 内联成字符串（`src/assets.d.ts` 声明模块类型）。不把 CSS 写成 `client.ts` 里的模板字面量：那份样式有 570 行，注释里任何反引号都会提前终止字符串，表现为莫名其妙的语法错误（2026-10-21 连续踩坑 6 次）。样式取自宿主的 `--dsw-alias-*` 主题变量，不引入独立配色或全局选择器。**唯一入口是整窗面板**：`sidebar.panellist` 图标 + 同 id 的 `main` keyed slot（`width:100%;height:100%`）。不注册 `settings.section` —— 宿主设置模态固定 800px，减去左导航 188px 与内容区左右各 24px 后真实可用宽度只有约 564px，本插件的表格与双栏图表在那里只能横向滚动。布局契约：**页面本身不滚动**（`.chub` 用 `overflow:hidden`），概览头与页签常驻，只有 `.chub-body` 滚动。概览头刻意压扁（单行标题 + 说明 + 状态胶囊 + 四个小指标，实测 87–91px），把高度留给正文。表格**不产生横向滚动条**：长文本列折行并给 `min-width:9em` 下限（否则邮箱会被压成竖排单字），次要列在 `@container (max-width:1400px)` 下整列隐藏。即便窄到仍需要横向滚动（用户带侧栏时会发生），滚动条也**常驻可见**：运行日志页的内容区填满剩余高度，日志面板 `flex:1`、表格容器自己 `overflow:auto`，故横向滚动条贴在容器底边而无需先滚到末行；`.chub-scroll` 用 `scrollbar-width:auto` + 显式 `::-webkit-scrollbar` 尺寸，避免 Windows 上 Chromium 的覆盖式滚动条淡出后无法抓取。运行日志**没有「详情」列**（逐行 attempts JSON 过于占宽，错误原因改挂「结果」徽标的 `title`）；单元格默认 `vertical-align:middle`，只有真正含 `details` 的格子才顶部对齐 —— 不得用 `td:last-child` 按位置选中（详情列一移除就会误伤新的最后一列）。「账号透视」与「模型性能」上下堆叠（`.chub-stack`）而非并排，并把表格宽度收到 1180px 上限，避免 7 列被摊到 2500px 后列间空白过大。分栏断点用 `@container` 而非 `@media` —— 视口宽度与真实可用宽度不是一回事。渠道卡网格**行内等高**（`align-items:stretch`），2 个以上账号的卡片由 `data-multi` 标记后**跨两列**、账号在卡内 `auto-fit` 并排：账号块是纵向列表，多一个账号就多一整块，而网格按行对齐 —— 旧写法（`align-items:start`）在 1440px 下实测产生 634px 死白，其中 502px 仅来自「双账号卡与单账号卡同排」。剩余高度交给账号列表与操作行（`flex:1` + `margin-top:auto`）吸收，空状态卡片同样伸展，故空白不会堆在卡底。**窄到单列时必须收回 `grid-column:span 2`**（`@container chub (max-width:820px)`），否则会造出隐式第二列把卡片挤成半宽。跨列卡还带来一个**结构性约束**：CSS 网格不会把跨列卡塞进行尾剩下的那一格，只能整体换行 —— 于是「单列卡 + 跨列卡」凑不满一行时前一行右侧会空一整格（实测的真实顺序 `1-2-1`）。故渲染前由 `packChannels` 按**实测列数**（`ResizeObserver` 读 `grid-template-columns` 的轨道数，不能用视口宽度猜）把卡片装成满行：跨列卡后紧跟 `columns - 2` 张单列卡。必须真的重排 DOM 顺序，不能靠 `grid-auto-flow:dense` 或 `order` —— 那两者让视觉顺序偏离 DOM，Tab 焦点与读屏顺序会错位。分析与方案对比见 [布局方案](LAYOUT.md)。

渠道的认证、目录、推理、额度与领取分开调用。目录读取不能触发选号，也不能覆盖正在生成的账号归属。宿主调用通过 prepareCall 包装，不能只测试 stream 方法。CodeBuddy CN 与 WorkBuddy 国区共用 `buddy` 渠道，不设其他别名。

### 折扣生效判据（唯一真相源）

所有渠道共用 `src/core/rate.ts` 的两个函数，**不得**在别处再写一套判断：

| 函数 | 职责 |
|---|---|
| `discountOf(model)` | 把任意渠道条目归一成 `Discount`（原价 / 折后价 / 每日时段 / 有效期 / 角标） |
| `isActive(discount, now)` | 唯一判断「此刻是否生效」：有效期 + 每日时段 |

两条硬规则：

1. **只按「窗口 + 当前时刻」判断，不按「抓取时刻」。** 目录里的「当前价」类字段（Qoder 的 `price_factor`、Trae 的 `consumption_rate`、Buddy 的 `discountedCreditsRate`）是抓取那一刻的快照，长期运行的会话里会过期。用它当真相，价格就随「上次刷新目录的时间」跳变而不是随真实计费规则变化。
2. **星期限制属于每个时段，不是整条活动。** Trae 实测 `deepseek-v4.1-flash` 是「工作日三段 + 周末全天」；合并成全局星期集会得到空交集、退回「每天」，于是周末的全天窗口覆盖掉工作日限制。

展示口径：`rateLabel` 在窗口内展开 `原价→折后价`、窗口外只报原价；`promotionNote` 给**短** chip（窗口外带「未生效」后缀 —— 循环窗口明天还会再来，藏起来等于活动不可发现；一次性活动过期则整条消失，不挂标签）；`promotionWindow` 给完整时段（不受「此刻是否生效」影响，用户需要知道几点打折才能安排）。

中断只记录**确定的来源**：调用方 signal 取消、插件 `close()` 停止，两者分别给出不同中文说明并保留原始英文括注；没有来源的异常一律记 `failed` 并保留真实原因，适配器正常收尾触发的清理 abort 不算取消。`redact` 负责把任意抛出物（含 `reason`/`cause`/`failure` 包装与普通对象）读成一句可读文本，绝不产出 `[object Object]`。

## 数据流

DSH prepareCall → 请求执行 → 显式选号 → 上游尝试 → 标准流事件。

请求 AsyncLocalStorage 保存本次请求和服务账号；上游 fetch 包装在实际调用点创建尝试，读取标准 usage 并保留失败消耗。已向调用方输出后禁止透明重放。数据库故障不改模型结果，但显示记录异常。

SQLite 表包含 requests、attempts、daily 和 kv。daily 的空账号行用于逻辑请求与全局汇总，非空账号行用于账号透视；两类行不能混加。永久保存统计所需的和与样本数，避免平均值再平均。

统计分组**必须带上渠道**：模型分组键是 `provider/model`，账号分组键是 `provider/accountId`，两者都以**结构化字段**（`provider`、`model`/`accountId`）回传给界面，由界面拼成「来源 / 名称」。只按模型名分组会把不同渠道的同名模型合并（实测 `deepseek-v4.1-flash` 横跨 workbuddy / trae / codearts / buddy 四个渠道，合并后速度与成功率被算成一个平均值，无法判断是哪个渠道慢）；也不能让界面去劈 `id` 字符串——账号显示名可能含 `/`，劈出来的「来源」会错。

`stats.dailyByProvider` 给出**每日 × 渠道**的交叉统计（按本地自然日，已按日期升序、同日按 Token 降序排好），供「每日 Token 消耗」画按来源分段的堆叠柱。排序放在宿主侧，柱段顺序与图例顺序因此稳定，不随查询顺序漂移。

图表有**两套口径**，必须各自标明：柱形是**每天**的量，图例是**整个筛选区间**的合计。图例以「合计 N Token · M 天」开头，该合计由各渠道合计**相加得出**（与 KPI 的 `totals.totalTokens` 逐字相等，实测全部 731,883,769 / 今日 629,198,874），否则用户按图例相加会对不上。

## API

通过宿主 connection 注册 `/api/channel-hub`，不额外监听管理端口。客户端使用 `connection.rpc.call('/api','channel-hub',{version:1,method,payload})`。

方法组：channels.list；channels.selectAccount（固定/自动选号）；channels.setExtendedContext（大窗口档开关，目前仅 Trae 的 Max 1M，默认关）；login.start/poll；accounts.update/delete/renew/balance/claim/reorder；credits.refresh（批量刷新额度，单个失败不中断其余）；models.refresh/setDisabled（单模型、当前目录整批或全部启用）；usage.summary/series/accounts/models；requests.list/detail；migration.preview/import；health。

额度读数：`channels.list` 每个账号带 `credits`（归一化读数）与 `balance`（原始快照）；`accounts.balance` 刷新一个账号并返回新读数。快照保留上次成功读数，刷新失败只追加 `error`，不清掉旧值。

时间、渠道、账号与模型过滤在服务端执行。当前看板时间选择为今日和全部，日汇总按北京时间日粒度查询；明细独立分页。

## 来源策略

认证与账号池以本地 OFM 快照为基准。Qoder 目录解析器取自固定的新渠道上游提交。Connect 的经验用于续期、目录与迁移兼容，不另保留第二套登录体系。目录刷新允许认证实现内部回退：可选端点失败但主目录已返回模型时不算失败，只有最终没有任何模型才把记录到的错误上报到账号快照。

vendor 中保留来源快照用于比对；构建只跟随真实 import 图，不加载旧 index、RPC、网关及其他平台功能。新版本每月审查上游差异，按问题移植，不全量合并。

上游来源（用于比对与追溯）：

| vendor | 上游仓库 | 基线提交 |
|---|---|---|
| `vendor/ofm/src/` | `https://github.com/Ebony-Vinyl/dsh-our-free-model` | `5923ebef0f55578ca21bb5555b7ba5adb51aef21` |
| `vendor/connect/` | `https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect` | `3738a114f121d8198ceeaf6e02763eb97a2fc109` |
| Qoder 目录解析器参考 | `https://gitee.com/iJetLi/deepseek-harness-codearts` | `9719ccffb975d18df32ac17948d46938c3b5e6fd` |

逐文件哈希清单已移除：它没有消费方（没有脚本或 CI 读取），且实测从首次提交起就与磁盘文件不符（114 个条目中 59 个不一致，含从未改动过的文件），继续维护只会产生「看起来在核对、其实早已漂移」的假安全感。**本地改动以验收记录为准**（`docs/ACCEPTANCE.md` 逐条写明改了什么、为什么、如何验证），比一组对不上的哈希可读且可审计。

### vendor 内的本地改动（按文件记账）

规则：只改**必须改**的地方，每处都要能回答「不改会出什么错」。上游每月审查时按这些条目比对，不做全量合并。

| 文件 | 改动 | 原因 | 验收 |
|---|---|---|---|
| `vendor/ofm/src/trae-product.ts` | `resolveMaxModeFlag` 改回复用 `isTruthyFlag`（`DSH_TRAE_MAX_MODE` **默认关**）；`TraeProduct.maxMode` 的文档改写 | 目录只下发一个 `consumption_rate`，没有 Max 档倍率字段；默认开启等于替用户选一个价格未知的档位 | `docs/ACCEPTANCE.md` 2026-10-24 第 1 项；`tests/trae-context.test.mjs` 的「defaults Max mode to off」 |
| `vendor/ofm/src/trae-adapter.ts` | `maxModeFor` 增加「远端必须下发 `context_window_tokens.max`」判据；`contextWindowFor` 不再用 `TRAE_MAX_CONTEXT_TOKENS` 补位；新增 `maxTierFor` / `maxModeEnabled` / `setMaxModeEnabled` | 原 `?? 1_000_000` 会给「只标了 `max_mode`、没给窗口」的模型凭空声明 1M（实测 `kimi-k2.6`，dev 仅 116000） | 同上第 2、3 项；`tests/trae-context.test.mjs` 的「refuses Max mode when the remote flags it without a window」 |
| `vendor/ofm/src/trae.ts` | `traeMaxModeFields` 在 `maxContext` 非正数时返回 `undefined`；新增 `readOffPeakDiscount` / `TraeOffPeakDiscount` / `TraeTimeWindow`，`TraeRemoteModel.offPeak`，`readActivityDiscount` 在时段折扣可解析时让位 | 窗口是上游准入参数，编一个必然被拒或静默截断；时段折扣的 `current` 是抓取快照（实测 `DeepSeek-V4-Flash-Official` 的 `current.discount_type` 是 `none` 却带 00:00–08:00 / 22:00–24:00 半价），旧实现整条丢弃 | `tests/trae-context.test.mjs` 的「refuses to invent a context window」；`tests/trae-offpeak.test.mjs` 16 项 + `tests/trae-offpeak-live.test.mjs` 3 项（真实快照） |
| `vendor/ofm/src/gemini-adapter.ts` | `resolveModel` 接上 `geminiFallbackEntries()`（远端优先、静态表补位） | 该表此前只被 import、零调用方；真实 `fetchAvailableModels` 不下发 `inputTokenLimit`，导致宿主 `dsh-compaction-basic` 每步抛 `no context capacity` | `tests/context-report.test.mjs` 的 Gemini 三项 + `tests/host.test.mjs` 的 `prepareCall().context` 断言 |
| `vendor/ofm/src/llm-adapter.ts` | `resolveModel` 改为「远端窗口优先、静态表兜底」；**不**声明 `defaultMaxTokens` | 目录若带上真实窗口应优先；输出上限仍由实测过的 `max_tokens ?? 65536` 统一收敛（131072 会被后端拒成空流） | `tests/context-report.test.mjs` 的 CodeArts 三项 |
| `vendor/ofm/src/models.ts` | `RemoteModel` 增加可选 `contextWindow` / `maxTokens`；`parseModelInfo` 宽容读取并导出 | 两个目录端点若下发窗口就透传；认不出留 undefined，**不补默认值** | 同上「directory parsing only forwards windows the upstream declares」 |
| `vendor/ofm/src/buddy-adapter.ts` | `BuddyAdapterOptions` 新增可选 `rewriteSystem` 钩子；在系统消息组装完成、指纹改写**之后**调用，按「全量替换」语义改写 system 消息并去掉重复项 | Buddy 国区正常对话被上游以 `code 11128 Illegal API invocation from an unapproved channel` 拒绝，实测触发点在系统提示词。模板与「换不换」的策略归 `src/`（`src/system/`）维护，vendor 只留一个最小接线点，避免本地策略长进固定版本快照 | `tests/buddy-system.test.mjs` 13 项；`tests/host.test.mjs` 的 Buddy 段（整篇替换、模型槽位、用户内容不变）；真实推理验收见 `docs/ACCEPTANCE.md` 2026-10-28 |

## 边界

没有自动安装、真实账号导入或部署操作。浏览器入口目前完成构建、组件注册与模拟状态的静态布局检查，尚未完成真实桌面窗口的视觉与交互验收。各渠道真实登录、余额、领取、续期、推理必须逐项补充验收记录。`src/reload.ts` 只在存在 `src/index.ts` 的检出中启用，安装包不包含源码；首次启用仍需重启 DSH。
