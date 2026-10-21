# 架构与维护边界

## 模块

- `src/index.ts`：DSH 生命周期、profile 路径、凭据引用命名空间、鉴权连接中的版本化 RPC。
- `src/drivers/`：OFM 认证/账号池与各渠道驱动的装配；Gemini 动态发现补充。Gemini 额外接线 `gemini-sigstore`：`thoughtSignature` 缓存按渠道建一次并长期复用、停止时落盘（不接则每轮工具调用都无签名，上游 400）；项目号探测缓存同理。
- `src/core/`：请求上下文、物理尝试、统一指标、目录快照与续期调度；`rate.ts` 只做各驱动计费系数的展示归一化（不按时间窗口推算）并把活动时段/角标整理成独立文案，缺失不补值；`promotion.ts` 在**已有的** `/v3/config` 响应上补出折扣时段与角标（不新增端点，vendor 快照哈希不变）；`credits.ts` 把各渠道额度响应归一成 `{ label, progress, packages, error }` 的展示读数（读数文案在宿主拼好，浏览器只画；查不到不显示成 0，token 与积分不合并，面值未知不补 100%，全零占位包不否决同账号其它包的面值）。
- `src/storage/`：数据库工作线程；请求明细与日汇总在同一事务终结。
- `src/migration.ts`：只读旧数据、格式转换、幂等导入与模型偏好合并。
- `src/reload.ts`：仅开发检出的模块缓存清理、原位重载与目录监视；不改变 RPC 或安装布局。
- `src/client.ts`：构建为唯一浏览器入口，渠道、看板、日志三个页面；**样式在独立的 `src/client.css`**，由 esbuild 的 `text` loader 内联成字符串（`src/assets.d.ts` 声明模块类型）。不把 CSS 写成 `client.ts` 里的模板字面量：那份样式有 570 行，注释里任何反引号都会提前终止字符串，表现为莫名其妙的语法错误（2026-10-21 连续踩坑 6 次）。样式取自宿主的 `--dsw-alias-*` 主题变量，不引入独立配色或全局选择器。**唯一入口是整窗面板**：`sidebar.panellist` 图标 + 同 id 的 `main` keyed slot（`width:100%;height:100%`）。不注册 `settings.section` —— 宿主设置模态固定 800px，减去左导航 188px 与内容区左右各 24px 后真实可用宽度只有约 564px，本插件的表格与双栏图表在那里只能横向滚动。布局契约：**页面本身不滚动**（`.chub` 用 `overflow:hidden`），概览头与页签常驻，只有 `.chub-body` 滚动。概览头刻意压扁（单行标题 + 说明 + 状态胶囊 + 四个小指标，实测 87–91px），把高度留给正文。表格**不产生横向滚动条**：长文本列折行并给 `min-width:9em` 下限（否则邮箱会被压成竖排单字），次要列在 `@container (max-width:1400px)` 下整列隐藏。即便窄到仍需要横向滚动（用户带侧栏时会发生），滚动条也**常驻可见**：运行日志页的内容区填满剩余高度，日志面板 `flex:1`、表格容器自己 `overflow:auto`，故横向滚动条贴在容器底边而无需先滚到末行；`.chub-scroll` 用 `scrollbar-width:auto` + 显式 `::-webkit-scrollbar` 尺寸，避免 Windows 上 Chromium 的覆盖式滚动条淡出后无法抓取。运行日志**没有「详情」列**（逐行 attempts JSON 过于占宽，错误原因改挂「结果」徽标的 `title`）；单元格默认 `vertical-align:middle`，只有真正含 `details` 的格子才顶部对齐 —— 不得用 `td:last-child` 按位置选中（详情列一移除就会误伤新的最后一列）。「账号透视」与「模型性能」上下堆叠（`.chub-stack`）而非并排，并把表格宽度收到 1180px 上限，避免 7 列被摊到 2500px 后列间空白过大。分栏断点用 `@container` 而非 `@media` —— 视口宽度与真实可用宽度不是一回事。

渠道的认证、目录、推理、额度与领取分开调用。目录读取不能触发选号，也不能覆盖正在生成的账号归属。宿主调用通过 prepareCall 包装，不能只测试 stream 方法。CodeBuddy CN 与 WorkBuddy 国区共用 `buddy` 渠道，不设其他别名。

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

方法组：channels.list；login.start/poll；accounts.update/delete/renew/balance/claim/reorder；credits.refresh（批量刷新额度，单个失败不中断其余）；models.refresh/setDisabled（单模型、当前目录整批或全部启用）；usage.summary/series/accounts/models；requests.list/detail；migration.preview/import；health。

额度读数：`channels.list` 每个账号带 `credits`（归一化读数）与 `balance`（原始快照）；`accounts.balance` 刷新一个账号并返回新读数。快照保留上次成功读数，刷新失败只追加 `error`，不清掉旧值。

时间、渠道、账号与模型过滤在服务端执行。当前看板时间选择为今日和全部，日汇总按北京时间日粒度查询；明细独立分页。

## 来源策略

认证与账号池以本地 OFM 快照为基准。Qoder 目录解析器取自固定的新渠道上游提交。Connect 的经验用于续期、目录与迁移兼容，不另保留第二套登录体系。目录刷新允许认证实现内部回退：可选端点失败但主目录已返回模型时不算失败，只有最终没有任何模型才把记录到的错误上报到账号快照。

vendor 中保留来源快照用于比对；构建只跟随真实 import 图，不加载旧 index、RPC、网关及其他平台功能。新版本每月审查上游差异，按问题移植，不全量合并。

## 边界

没有自动安装、真实账号导入或部署操作。浏览器入口目前完成构建、组件注册与模拟状态的静态布局检查，尚未完成真实桌面窗口的视觉与交互验收。各渠道真实登录、余额、领取、续期、推理必须逐项补充验收记录。`src/reload.ts` 只在存在 `src/index.ts` 的检出中启用，安装包不包含源码；首次启用仍需重启 DSH。
