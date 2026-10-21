# 验收记录

日期：2026-10-21。版本：0.1.0-alpha.1。

## 已完成

- TypeScript 核心与管理界面类型检查。
- 测试总览：93 项核心/目录/续期/迁移/登录协议/热重载辅助测试、11 项错误/用量/余额形状回归测试、4 项客户端测试、3 项真实宿主契约测试。
- 数据看板补轮次维度：新增「轮次 / 步数」KPI（含平均步/轮，并标注「按明细保留 90 天」——`daily` 日汇总不存轮次）；流式速度与整块吞吐拆成两张并列卡片，不再挤在一张卡的主值 + 副行里。`stats` 增加 `counts: { turns, steps }`，按当前筛选范围从 `requests` 现算，既有的 totals / series / accounts 口径不变。
- 记账故障不得拖住推理：`WorkerStore` 补齐初始化失败（工作线程在 `ready` 之前退出/抛错时 `ready` 立即拒绝）、单次调用超时（默认 5 秒，`DSH_CHANNEL_HUB_STORE_TIMEOUT_MS` 可调）与未完成调用上限（默认 200，`DSH_CHANNEL_HUB_STORE_MAX_PENDING` 可调）。超时/超限即失败并摘除待处理项，迟到的回包不会二次结算；观察者把它计为 `failedWrites` 后继续，模型输出不受影响。夹具用可注入的替身工作线程覆盖三条路径与正常握手。
- 请求收尾不再漏：观察者的上游迭代器创建移入 `try` —— 驱动同步抛错（凭据缺失、参数校验、适配器异常）也会走 `finally`，请求落成 `failed`、写入 `finish`，并释放活跃槽位（`isIdle()` 为真），不会卡住关闭与热重载。
- 统计成本随历史增长可控：`daily` 的过滤（日期 / 渠道 / 模型 / 账号）全部下推到 SQL，新增 `daily_account(provider,accountId,day)` 索引；运行日志的尝试明细改为按页一次性批量查询（原来每条 step 一次 `detail()`）。合成夹具断言过滤口径与改动前逐项一致。
- 旧运行日志清理（一次性，经用户确认）：删除迁移前无 `sessionId` 的明细 1424 条（连带 1504 次尝试），保留新口径的轮次明细；`daily` 36 条日汇总未动，历史累计请求数仍为 1533。清理后账本为 **109 步 / 17 轮**（平均 6.4 步/轮），运行日志不再被历史单步行淹没。
- 运行日志按**轮次**统计：一条用户消息引发的多次模型调用共享 `turnId`，日志一行一轮、可展开逐步。DSH 只向适配器下发 `sessionId`（无 turn/step），轮次按「最后一条消息是不是纯用户消息、且不含 tool-result」推断；无会话 id 的调用各自成轮。旧库行回填成各自成轮，不编造轮次。已用真实账本只读核对：`user_version=2`、新请求带 `turnId`/`sessionId`；新口径生效后的真实流量为 **52 步 → 8 轮**，而迁移前的历史行仍按各自成轮统计。
- 速度分两个独立指标：**流式速度** = 输出 /（首字 → 结束），**整块吞吐** = 输出 /（请求开始 → 结束）。两者分母不同，分别平均、分别展示，不合并——否则既低估又高估。合成夹具覆盖「无首字时流式速度为 null、整块吞吐仍可得」与「两者各按各的分母」。
- 速度长期恒为空值（看板两个数字都是 `—`）的根因与修复：`finish` 落库时最后一条 attempt 常常还没定稿（适配器先结束迭代，`ended` / `outcome` 由 fetcher 稍后补写），原实现直接读 `final.ended`，`ended > first` 恒为假，样本被**系统性**丢成 0（真实账本当日 945 条请求 0 个样本）。现在用请求自身的结束时刻与结果兜底，并在看板副行显示样本数（「N 个样本」），避免用三五个样本的平均值冒充整体。回归夹具同时覆盖「measure 层」与「落库到 daily 的整条链路」。实测修复后：新增 6 条请求产出 6 个吞吐样本、3 个速度样本（其余步骤本就没有首字）。
- 真实宿主契约（4 项）：10 个渠道条目注册（CodeBuddy 与 WorkBuddy 国区共用一个渠道，不设 `workbuddy-cn` 别名；Trae 只保留一个 CN IDE 渠道，可登录，不含旧 SOLO 或 `trae-cn` 副本）；prepareCall → Qoder WASM → 模拟 SSE → SQLite 记账；**prepareCall → Gemini → 签名从 thought part 捕获并落盘 → 下一轮以真签名回填**（模拟上游，不联网；断言 `gemini-sigs.json` 内含该签名、第二轮 wire 体里 `functionCall.thoughtSignature` 是真值而非哨兵）；真实 Cordis fiber 加载与释放。
- 2 项 Qoder 业务错误归类测试：用真实账号实测的帧形状（HTTP 200 + 双层 SSE 信封）断言「今日次数用完」（`110 Billing daily count exceeded`）归类为 `QUOTA_EXCEEDED`（不可重试，避免白重试 5 次）并给出中文提示、保留英文原文；排队（`10605 isQueued queueType:p3`）不得被误归成额度用尽。
- 1 项计费系数展示归一化测试：Qoder `0×`/`0.5×`、CodeBuddy 字符串 `x0.29` 与促销箭头、Trae 数字倍率与促销、LobsterAI `costMultiplier`；字段缺失、空串、`NaN` 不渲染，不补 `x1`。
- 2 项限时/限时段折扣测试：倍率**不按窗口推算**（白天夜里同一值，不随读取时刻跳变）；活动以独立琥珀色标签放在计费标签左侧，标签只放短角标（`夜间折扣`、`夜间免费`、`错峰 4 折`），完整时段（`23:00–07:50`）单独给出并进入悬停说明；白天抓目录时 OFM 已丢弃折后价、只剩本插件补的 `promotion` 时，折扣仍能从 `promotion.rate` 取到；Trae 只有活动终点时显示「限时折扣至 …」且过期后标签与时段都不再出现。折扣解析保留带窗口的 `factor: 0`（真免费），丢弃无窗口的 `0x` 占位与已停用活动。
- 3 项 WorkBuddy 国际版登录夹具：`expiresIn: 0` 与 `expiresAt: 0` 不产生“登录即过期”，相对有效期正确换算，账号昵称使用 `login/account` 返回值而非随机账号 id。夹具为合成响应，未使用真实账号。
- 2 项 Trae CN IDE 登录夹具：授权 URL 的完整参数与 CN 客户端/版本身份；本机回调接收 `refreshToken` → `ExchangeToken` → `GetUserInfo` → 凭据组装。回调与上游均为本机夹具，未使用真实账号。
- 上述 Qoder 链路同时验证 Gemini 远端目录接线。所有网络响应均为夹具，凭据为合成值。
- WorkBuddy 国际版目录夹具同时验证：可选企业端点返回 500 时不得丢弃 `/v3/config` 已下发的模型；只有全部目录请求都失败且没有模型时，才按账号上报错误；模型菜单保留上游计费系数（`GPT-5.5 · x0.29→免费`），不因显示改写丢失；限时折扣的时段与角标进入 `channels.list` 的模型快照，供界面展示；批量关闭一次落盘并隐藏当前目录，全部启用清空该渠道黑名单，`all + disabled` 被拒绝以免写入未知 id。
- Qoder CN 推理链路只读实测（真实账号，最小 prompt）：COSY 签名与 WASM 加密请求均被接受（HTTP 200），上游返回的是**业务错误**而非协议错误 —— 各模型普遍回 `code:110 Billing daily count exceeded`，免费档 `dfmodel` 回 `10605 isQueued queueType:p3`（排队 2860）。同账号 `/algo/api/v2/quota/usage` 显示 `isQuotaExceeded:false`、附加额度 890/2100，说明 110 是**当日对话次数**上限而非额度耗尽。据此把这两类确定性错误翻译成简短中文提示（额度提示 UTC+8 当日 24:00 重置），排队与额度分开归类。
- 4 项热重载辅助测试：模块缓存键只匹配本包文件；清理 ESM/CJS 缓存后可完整恢复；目录监视只上报过滤后的构建产物并能停止；Windows junction 安装按真实目标目录监视。
- 额度读数归一化测试（`src/core/credits.ts`，合成夹具）：多包求和只计有效包、失效包单独给 `expiredTotal`；`credit`/`credits` 单位归一；无面值（`total: 0`）只显示剩余、不补 100% 进度；**任一有效包面值未知时不给合计面值**（只对一部分包求和会得到比剩余还小的分母），**但全零占位包除外**（Qoder 免费档的 `套餐额度` 为 `{total:0,used:0,remaining:0}`，不否决同账号 `资源包` 的百分比；全零包单独成账号时只写剩余、不出现 `0 / 0` 或除零；报告过用量但无面值的包仍然否决）；Loomy / Raccoon 这类只下发余额、不发容量的渠道，包级 `total` 必须为 0，面板显示剩余而非「剩余 / 剩余」；token 口径的额度不被标成积分，混单位时逐单位给读数、不相加；`null`/抛错/未查询三种失败形态都不渲染成 0，刷新失败保留上次成功读数并带失败原因；包装结果保留 `error` 与账号规格；CodeArts Token 计费账户给如实说明；无法识别的响应标 `unknown` 不猜。展示格式（积分不压缩、token 压缩、数值与单位不留空格）与 vendor 口径一致。
- 8 项 Gemini `thoughtSignature` 往返测试（`tests/gemini-signature.test.mjs`，合成夹具）：上游把签名挂在 **thought part** 上时也要归属给紧随其后的 `functionCall`（真实报障形态，签名不在 functionCall 上）；functionCall 自带签名时优先于 thought part 的；同一 step 的并行调用只有首个 part 带签名；**当前轮**缺真签名时发 `skip_thought_signature_validator` 哨兵（上游文档明示的跳过校验值，省略字段必然 400）而不是干脆不带；缓存命中时原样回填且优先于哨兵；**历史轮不补哨兵**（上游只校验当前轮，补假签名会掩盖真实命中）；哨兵取值是文档字面串而非其 base64；签名改动不掺进 `generationConfig`。夹具不联网、不读真实凭据。
- 4 项 Gemini 签名缓存落盘契约测试（`tests/gemini-sigstore.test.mjs`，临时目录）：缓存落在 `channel-pack/` 与 `state.json` 同目录而不是塞进后者；签名经文件往返后精确键命中、参数漂移时按工具名取最近、换参数查不中；空串签名被丢弃、坏文件降级为空缓存而不抛错、目录不存在也能安全写入；签名键对同工具同参数稳定、只取正文前 512 字符。这些测试锁住的是缓存自身的契约，驱动层是否真的构造它由构建产物核对（`dist/index.js` 中 `createGeminiSigStore` 按渠道调用）。
- 9 项中断语义与错误可读性测试（`tests/abort.test.ts`，内存替身）：`redact` 对普通对象 / `reason.failure` 形状给出可读文本而不是 `[object Object]`；`AbortError` / `TimeoutError` 被点明为「请求已取消」/「请求超时」并保留原文括注；**能穿透 `reason`/`cause`/`failure` 包装取到真实原因**（`Error` 字段不可枚举，直接 JSON 化会得到 `{}`）；仍隐藏 `Bearer`/`token`，且对循环引用等敌意取值不抛、不产出 `[object Object]` 或 `null`/`undefined` 字面量；**正常收尾的流记 success 而不是 cancelled**（适配器读到 finish 就 return，旧实现会把这种清理 abort 记成取消）；调用方取消记 cancelled 并给出中文原因；**无取消来源的异常必须记 failed 且保留原始原因**（不得被抹成 cancelled）；`close()` 打断的请求记「插件已停止，本次请求中断」；`observer.fetcher` 的正常 teardown 不产生假 cancelled attempt。这些夹具不联网、不读真实账号。
- 2 项余额形状回归（`vendor/ofm/src/loomy-credits.ts`、`raccoon-credits.ts`，合成响应）：两者的各积分池只报余额，包级 `total` 恒为 0、`used` 缺省（不填 0，以免断言「确实没用过」）。夹具不联网、不读真实凭据。
- 19 项客户端测试：构建后的浏览器入口只注册**两个**宿主入口（`sidebar.panellist` 图标 + `main` 整窗页面）并声明服务依赖，**设置页入口不得存在**（若被加回，断言失败）；**侧边栏图标与 `main` 面板的 id 必须逐字相同**（宿主按 id 把两者绑定，写错则点图标抛 unknown panel）；页面本身不滚动、只有 `.chub-body` 滚动；概览头保持紧凑；**分栏断点必须走 `@container`**，`.chub-channels` / `.chub-kpis` 不得再出现在视口媒体查询块里；表格不产生横向滚动（长列 `min-width` + `break-word` + 窄容器隐藏次要列）；**日志表自己滚动**，横向滚动条贴在容器底边；**账号透视与模型性能必须堆叠**；**渠道卡的「添加账号 / 更新模型」必须与统计同一行且靠右**，靠右用 `margin-left:auto` 而非 `space-between`（统计项数量随内容变化，`space-between` 会让按钮位置左右跳动），且按钮组必须真的嵌在统计行内；**详情列移除后不得残留按位置的 `td:last-child` 样式**；日志表头不含「输入 / 输出」；**图例必须显示区间合计并标明「柱子是每天、图例是区间」**，且该合计由各渠道合计相加得出；**样式必须来自 `src/client.css` 且被内联进产物**（源码里不得再出现 `const css = \`` 模板字面量、产物里不得把它抽成独立资源）；**每日消耗的堆叠段必须有最小可见高度且总高不变**（含单渠道 / 全零 / 极小柱三个边界）；短信登录按钮依赖页面内表单而非 `window.prompt`（宿主 GUI 运行在 Electron 渲染进程，`prompt()` 未实现、调用即抛错）；资源包行内联显示上游下发的到期时间（`到期 …`，无到期时回落到 `周期至 …`）。端到端渲染另以构建产物 + 合成状态核对：有到期时间的包显示 `到期 <日期>`，Loomy 卡片显示 `19,992积分` 且不出现 `19,992 / 19,992`。
- 两套口径的一致性核对（只读复制本机 `ledger.sqlite`）：KPI 的 `totals.totalTokens`、`sum(series)`、`sum(dailyByProvider)`、`sum(providers)` **四者逐字相等** —— 全部 731,883,769、今日范围 629,198,874，天数均为 2 天。这正是「图例显示区间合计而柱子显示每天」不会让人误读的前提：口径不同但总量自洽。
- 每日消耗按来源分段的实测（无头 Edge + 从构建产物取出的真实 `stackHeights`，数据用 2026-10-21 真实账本量级）：11 个渠道共 11 段、11 种颜色、图例 11 项且每项带区间合计；**最小段从 0.002px 抬到 2.00px**（旧实现里后 8 个渠道完全看不见），同时堆叠总高仍为 **108.000px**（跨日期可比性未被破坏）；大段按富余量等比让出（43.4 → 39.8px），相对顺序不变。
- 1 项每日 × 渠道交叉统计回归（`tests/storage.test.ts`，`:memory:`）：两天 × 两渠道产生 4 行；日期升序、同日按 Token 降序（堆叠顺序与图例顺序由它决定）；**每天各渠道之和必须等于当日汇总**，两者不能对不上。
- 样式迁出模板字面量的结构性修复：`src/client.css`（569 行）经 esbuild 的 `text` loader 内联为字符串，`dist/` 不产生独立 `.css` 资源；`src/assets.d.ts` 声明模块类型以通过 `tsc`。此前样式是 `client.ts` 里 570 行的模板字面量，CSS 注释里任何反引号都会提前终止字符串（连续踩坑 6 次），迁移后反引号在 CSS 中只是普通字符。
- 日志页横向滚动条常驻性实测（无头 Edge，40 行日志）：1166px 视口下表格容器内部 **纵向 3500/475、横向 1195/1076**，即两个方向都在容器内滚动；容器底边距视口底部仅 **57px**（正好是分页条高度），横向滚动条因此贴在容器底边、无需先滚到表格末行即可抓取；`scrollbar-width: auto`（非覆盖式）。1560px 视口下横向溢出消失（`inner scrolls X: no`），只剩纵向滚动条 —— 没有横向溢出时不应凭空出现横向条。
- 1 项统计分组回归（`tests/storage.test.ts`，`:memory:`）：同一个模型名挂在两个渠道上时必须是**两行**而不是合并；每个模型分组都带回结构化的 `provider` 与裸 `model`，每个账号分组带回 `provider` 与 `accountId`，且 `id === provider + "/" + accountId`。
- 「来源 / 名称」的真实数据核对（只读复制本机 `ledger.sqlite` 到临时目录后统计，不改原库）：模型分组由 14 组变成 **17 组**，多出的 3 组正是旧实现错误合并的 —— `deepseek-v4.1-flash` 现拆为 workbuddy 526 / trae 88 / codearts 27 / buddy 4，`glm-5.3-flash` 拆为 buddy 57 / trae 18。界面渲染核对：表头为「来源 / 名称」，行为 `workbuddy / rebelberial@gmail.com`、`trae / deepseek-v4.1-flash` 形式，来源弱化一档、分隔符再淡一档。
- 三处界面调整的实测（无头 Edge + 构建产物 CSS，2560/1600 两档）：运行日志表 **13 列**（「详情」列已移除），最后一列「缓存命中率」`vertical-align: middle`、内容相对行中线偏移 **0.0px**；「账号透视」与「模型性能」的容器为 `flex-direction: column`，两表 top 分别为 344px / 551px，判据 `side by side: no (stacked)`；概览头高度 87px。过程中另修掉两个由改动引出的问题：① 旧的 `td:last-child{vertical-align:top}` 专为详情列而写，详情列移除后会误伤新的最后一列（这正是用户报障的表现），改为 `td:has(details)` 按内容选中；② 两张看板表改成整行后 `width:100%` 被摊到 2500px、列间空白过大，加 `max-width:1180px` 收窄。
- 渠道卡「统计 + 操作」同行的实测（无头 Edge + `src/client.css`，380 / 640 两档卡宽）：普通渠道卡在 380px 宽下统计行只有 **1 行**（高 30.8px），按钮组右边界与卡片内边距内侧的差值 **0.0px**（贴边），文字块右缘到按钮左缘 **22px**；640px 宽下同样贴边，中间留白 **282px**（全部由 `margin-left:auto` 吃下）—— 这两档证明按钮是靠右而不是紧跟在文字后面。Loomy 三按钮卡在 380px 下换行成 3 行（高 52.8px），但右边界依然贴边，即换行后不会缩回左边。旧的 `justify-content:space-between` 方案会把这段留白均分成三段、按钮位置随统计项数量变化，故未采用。
- 更早的布局验收（14 列日志表，2560×1440 / 1600×900 / 1280×800）：概览头 **91 / 87 / 87px**；`page overflow-y=hidden` 且 `body overflow-y=auto`；三档均 `table h-scroll = no`。该轮修掉的两条缺陷：长账号被压成竖排单字（`overflow-wrap:anywhere` → `break-word` + 长列 `min-width:9em`）；1280px 仍溢出 137px（`@container (max-width:1400px)` 隐藏次要列）。移除设置入口前的对照：同一 1560px 视口下，按宿主设置模态尺寸搭出的容器里内容宽只有 **564px** —— 差 2.8 倍。
- 用构建后的浏览器入口与模拟状态在 Edge 无头模式渲染三个页面，按 1280 / 1180 / 760 / 560 四档宽度检查概览头、状态标签、渠道卡片、账号操作、筛选、KPI、图表、模型行计费系数与活动标签、模型批量启用/禁用按钮和表格滚动；模型列表为单列，字号整体上调一档（正文 13→15px、模型行 10→12px、标签 9.5→11.5px），日志表「详情」列限制宽度避免撑破容器。仅作布局静态检查，未连接真实宿主数据。
- 本机桌面运行时确认支持 SQLite。

## 真实账号验证

以下均使用本机已保存的真实账号，只读或最小请求，未改写运行 profile、未续期、未写凭据或账号池。

- **Buddy / WorkBuddy 最小推理**：实时远端目录 Buddy 国区 31 个模型、WorkBuddy 国际版 28 个；两端均选目录确认的 `hy3`。Buddy 普通 system 与含触发句的 system 各请求一次，均 HTTP 200、正文 `OK.`。WorkBuddy 在 64 token 上限下 HTTP 200 但无正文（未计成功），调整为 512 token / low 思考档后两次均 HTTP 200、正文 `OK.`。
- **Harness system 身份句**：Harness 发起的 Buddy `hy3` 请求报 HTTP 400 / `code:11128`；逐段缩小到首句 `You are an AI agent powered by DeepSeek Harness.`，该句单独发送同样 400。仅把 `powered by` 改成 `running in` 后，单句与完整 5764 字符 system 都返回 HTTP 200、正文 `OK.`；据此新增这一条精确模板兼容规则，未引入泛化关键词清洗。修复后经真实宿主 `LlmRuntime.prepareCall → stream` 重放原始 system，输出 `OK.`，账本 outcome 为 success、物理尝试数为 1。新规则的真实网络证据限 Buddy 国区 `hy3`；WorkBuddy 国际版对新句只有夹具覆盖。
- **Trae 缓存用量**：真实 Trae CN IDE 账号、远端确认的 `glm-5.3-flash`，两次相同合成 system 的 `token_usage` 分别为 `prompt_tokens=2727 / cache_read=0` 与 `2727 / 2688`。修复把 `cache_read_input_tokens` / `cache_creation_input_tokens` 映射到 DSH 的缓存字段并从含缓存的 `prompt_tokens` 中扣除，保留 `total_tokens`；`*_total` 零占位不覆盖本次计数，显式零保留、缺失或非法值维持未知。真实复测两次均输出 `OK.`，宿主与账本记录 input=39 / cacheRead=2688 / cacheWrite=0，单请求命中率 98.6%。
- **Qoder 国区/国际版用户名补齐**：原有两个账号凭据均缺 nickname、账号标签等于随机账号 id。修复在目录发现时补齐空白或等于账号 id 的生成标签：优先取凭据 nickname，否则走对应区域 `/api/v1/userinfo`（20 秒超时），`name` 为空时回退非空 `username`；保留自定义名称，不写凭据或设备字段。真实两个账号只读查询后 `upstreamNamePresent=true`、`displayIsGenerated=false`、`matchesUpstream=true`、`credentialRefUnchanged=true`。
- **额度轮询与自动续期**：宿主 BalanceService 启动即检查、后台每 30 秒扫描、单账号 5 分钟内复用读数；失败保留上次成功值并按 30 秒指数退避至 30 分钟。真实观察：五个账号均出现构建之后的成功额度更新时间，无 error/retryAt。5 分钟周期与退避由模拟时钟测试验证，未等待完整真实周期，也未制造真实凭据过期。
- **自动签到**：启动即检查、每五分钟扫描，按账号与 UTC+8 日期持久去重。真实观察：Buddy 国区与 Trae 为 done / 今日已签到，Qoder 国区与国际版为 waiting / 等待本轮活动刷新且 `coversToday=false`；WorkBuddy 国际版无签到入口。未来活动刷新后的领取未真实等待验证。

## 不计为通过的项目

- 所有渠道的真实账号网页登录、短信/扫码、续期、余额、领取，以及除上述 Buddy / WorkBuddy 最小请求外的推理。额度读数展示已按 vendor 已验证的响应形状验收，但各渠道真实账号的余额查询仍需逐项补充。
- Qoder 的成功补全：只验证到「请求被上游接受、返回业务错误」，未取得任何一次成功出字。当日次数上限（110）与免费档排队（10605）都是账号侧状态，不能作为协议正确性的证据。
- Gemini 发现接口在真实账号上的响应；除原 OFM 已支持模型外，不扩大推理声明。
- Gemini 真实 `thoughtSignature` 往返：签名捕获、缓存落盘与哨兵回填由合成夹具验证（含真实报障的报文形状与上游文档规则），**未**用真实账号完成一次「工具调用 → 回填签名 → 上游接受」的完整真实循环 —— 用户报障的 400 因此只验证到「不再发无签名请求」这一层，不能声称真实工具循环已跑通。
- CodeBuddy / WorkBuddy 国区共用一个渠道后的真实账号协议差异。
- Trae CN IDE 的真实浏览器授权、CN 账号 `ExchangeToken` 响应与续期；登录夹具只证明协议接线与凭据组装。
- Loomy 真实短信登录（需真实手机号与验证码，且会真实发送短信）；短信表单的行为结论只来自合成 RPC 桩驱动的构建产物。
- 多张图片、复杂工具连续调用及跨渠道真实历史的验收。
- 实际 DSH 窗口中的视觉和交互验收，以及长时间运行压力测试。侧边栏面板入口的布局以无头渲染 + 宿主 CSS 数值核对通过，但**未在正在运行的 DSH 窗口里点开验证**（该 GUI 需鉴权，无法从命令行驱动）；首次启用仍需刷新页面一次以加载新的客户端 bundle。
- 开发热重载的逐页视觉验收；辅助测试覆盖缓存清理、恢复、目录监视与 junction 目标解析。真实 DSH 中已观察到构建后自动重载并按真实账号刷新目录，但未做逐页视觉检查。首次启用仍需重启一次 DSH。

已实现对应接线不代表上述真实验收通过。本版本保持 alpha 标识。
