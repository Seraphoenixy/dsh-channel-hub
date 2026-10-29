# dsh-channel-hub

DeepSeek Harness 插件，在一个侧边栏面板里管理多家模型渠道的账号、模型目录、额度与请求记录。

登录后，目录发现、令牌续期、额度轮询与每日签到在后台进行；每次模型调用的账号、耗时、Token 与结果记入本地 SQLite。

![version](https://img.shields.io/badge/version-0.1.0--alpha.1-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-22.19%2B-3c873a)

> [!NOTE]
> 当前为 alpha 版本。构建、核心回归与真实宿主契约测试已通过，各渠道的真实账号验收尚未逐项补齐，建议先用少量账号试用。结论见[验收记录](docs/ACCEPTANCE.md)。

## 功能

- **渠道页**：9 个渠道条目，独立登录、独立配置账号。每个渠道可固定使用某个账号，也可自动选号；固定后限流与失败都直接报错，不会改用其他账号重试。
- **数据看板**：今日 / 全部范围的轮次、步数、Token、两项速度指标、缓存命中率与成功率；每日 Token 按渠道分段堆叠；账号与模型分开统计。
- **运行日志**：一条用户消息引发的多次模型调用归为一轮，一行一轮，可展开查看每一步的上游尝试与失败原因。

后台任务：令牌到期前 3 天续期，额度每 30 秒巡检（单账号读数 5 分钟内复用），每日签到按 UTC+8 自然日去重。

目录未下发的字段（上下文窗口、Max 档倍率、额度面值）保持为空，不以默认值或推算值填充。

## 支持的渠道

| 渠道 | 登录 | 目录 | 额度 | 签到 |
|---|---|:--:|:--:|:--:|
| 华为码道 CodeArts | OAuth（浏览器回调，PKCE / DPoP） | 动态 | ✅ | ✅ |
| CodeBuddy / WorkBuddy 国区 | 网页授权 | 动态 | ✅ | ✅ |
| WorkBuddy 国际版 | 网页授权 | 动态 | ✅ | — |
| Qoder CN | 设备授权 | 动态 | ✅ | ✅ |
| Qoder 国际版 | 设备授权 | 动态 | ✅ | ✅ |
| Trae CN IDE | 本机回调 + `ExchangeToken` | 动态 | ✅ | ✅ |
| Loomy | 微信扫码 / 短信 | 动态 | ✅ | ✅ |
| Raccoon | 微信扫码 / 短信 | 动态 | ✅ | ✅ |
| Gemini | Google OAuth（loopback） | 动态发现 | ✅ | — |

- **CodeBuddy 国区与 WorkBuddy 国区是同一产品**（同一登录端点与账号体系），只保留一个 `buddy` 渠道；国际版是独立的 `workbuddy`。
- **Trae** 只注册一个 CN IDE 渠道，旧的 SOLO 已并入。
- **Gemini** 只发布既有推理驱动支持且被远端确认的模型。
- 续期依赖刷新令牌：凭据里带 `refresh_token` 才会自动续期。Loomy 的凭据不可续期，巡检只用一次只读请求确认仍然有效。

## 安装

`dist/` 已随仓库提交，**安装无需构建**。

```powershell
dsh plugin --profile desktop add "D:\path\to\dsh-channel-hub"
```

安装后重启 DSH，侧边栏出现「渠道中心」图标，点开即铺满整个窗口。

<details>
<summary>从打包文件安装</summary>

```powershell
npm install --ignore-scripts
npm run pack:local          # → artifacts/dsh-channel-hub-0.1.0-alpha.1.tgz
dsh plugin --profile desktop add ".\artifacts\dsh-channel-hub-0.1.0-alpha.1.tgz"
```

安装包含 `dist/`、`cordis.patch.yml`、`LICENSE`、`README.md` 与 `docs/ACCEPTANCE.md`，不含源码、凭据、数据库或日志。
</details>

**前置**：DSH Desktop（在宿主库 `0.2.1-rc.2` / 桌面运行时 Node `24.17.0` 上验收）；运行时需要 `node:sqlite`，宿主自带的运行时已满足。

本项目不会自动装进正在运行的 DSH，也不会替换任何已有插件。

## 快速上手

1. 在渠道卡片点「添加账号」（就在状态徽标左侧），按提示在浏览器完成授权。授权成功后账号进入账号池，卡片显示额度读数。
2. 点渠道区块右上角的「更新模型」一次刷新**全部渠道**的动态目录；单个渠道失败不影响其余，失败项会在提示里逐个点名。模型可单独开关，也可按渠道批量启用或禁用。
3. 多账号时用「使用账号」决定路由：自动选号，或固定到某一个。固定后模型菜单只保留该账号可用的模型。
4. 打开「运行日志」确认请求已记账，再回到「数据看板」查看用量。

### 从旧项目迁移

「旧账号迁移预览」只读扫描本机旧数据源（OFM 的 `channel-pack/state.json`、Connect 的 `connect-channels.json` 与 `connect-auth/*.json`），列出可导入的账号与模型偏好。

- 只读：不修改旧文件，也不导入旧统计。
- 幂等：重复导入不会覆盖已重新登录的账号。
- 旧 Qoder 会话缺 `machine_id` 时标为「需要重新登录」，不补造设备身份。

导入含刷新令牌的登录态后，建议停用旧插件里的同名账号，避免两个插件同时轮换同一份令牌。

## 统计口径

| 概念 | 定义 |
|---|---|
| 请求 / 尝试 | 一次模型生成是一条请求；重试与换号是它下面的尝试 |
| 成功率 | 按最终请求统计，取消与进程中断单列 |
| Token | 含失败尝试已报告的消耗；缺失 usage 不等于 0；思考已含在输出里，不重复累计 |
| 缓存命中率 | 只用报告了缓存数据的样本，并给出覆盖率 |
| 流式速度 | 输出 Token /（首字 → 结束），只有观测到首字才有样本 |
| 整块吞吐 | 输出 Token /（请求开始 → 结束），含首字等待，总是可得 |

- 两项速度指标分别计算、分别平均，不合并。
- 按北京时间分日，跨日请求归入开始当天。
- 轮次由「最后一条消息是否为纯用户消息」推断（宿主只下发 `sessionId`）。压缩、标题生成等旁路调用若也以用户消息结尾，会被算作新的一轮。
- 明细保留 90 天，日汇总永久保留。

## 数据与隐私

- 数据在 `$DSH_HOME/profiles/<profile>/channel-hub/`（默认 `~/.dsh`），按 profile 隔离；凭据由宿主凭据服务保存，引用名带 profile 命名空间。
- 默认不保存提示词与回复正文；插件不打印令牌、DPoP 私钥、Cookie 或完整认证响应。
- 记账是旁路：数据库在工作线程中运行，写库超时或失败只累加 `failedWrites`，不影响模型输出。
- 网络请求只发往本机 DSH 与你所登录渠道的上游端点，没有额外的统计或遥测端点。

## 兼容性与验收状态

**已通过**：构建、类型检查、安装包校验，以及 143 项核心 / 79 项错误链 / 29 项客户端 / 5 项真实宿主契约测试。宿主契约覆盖 `prepareCall` → Qoder WASM → SQLite 记账，以及 Gemini `thoughtSignature` 的捕获与回填。真实账号侧完成 Buddy 与 WorkBuddy 国际版最小推理、Trae 缓存命中、Qoder 账号名补齐、额度轮询与自动签到。

**尚未验证**：上述条目之外的真实登录、续期、余额与推理；Qoder 只到「上游接受请求并返回业务错误」，未取得成功出字；Gemini 的完整工具调用循环；Trae Max 档的实际扣费倍率（上游不下发该字段）；运行中 DSH 窗口的逐页视觉与长时间压力测试。

逐项细节见[验收记录](docs/ACCEPTANCE.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧边栏没有「渠道中心」 | 确认装到了当前 profile 并重启 DSH；只更新了 `dist/client.js` 时刷新页面即可 |
| 点登录没弹出浏览器 | 面板保留了同一次授权的可点击链接，直接点它，无需重新发起 |
| 日志提示「N 个账号的渠道未注册」 | 账号来自构建里已移除的渠道，会被跳过，也不出现在渠道列表与模型菜单里。插件提供 `accounts.orphans` 与 `accounts.delete`，但不会自动删除，渠道重新加回后这些账号仍可用 |
| 额度显示失败原因 | 刷新失败保留上次成功读数并附上游原文；401/403 单独给出提示，先看原因再决定是否重新登录 |
| 模型菜单里少了模型 | 检查该渠道的目录快照与单模型开关；固定账号后只发布该账号确认可用的模型 |
| 历史明细不见了 | 明细保留 90 天，日汇总永久保留；清理明细不影响历史累计 |

## 开发

```powershell
npm install --ignore-scripts
node scripts/extract-host.mjs   # 从本机 DSH app.asar 提取真实宿主包到本项目 node_modules
npm run check
```

`extract-host.mjs` 只写入本项目的 `node_modules`，不修改正在运行的 profile（`DSH_ASAR` 可指定安装位置）。缺少宿主依赖时 `test:host` 以退出码 2 结束，核心测试不需要宿主。

| 命令 | 作用 |
|---|---|
| `npm run build` | 构建 `dist/`（esbuild，产物入库） |
| `npm run dev` | 监听 `src/` 与 `vendor/` 并重建，配合热重载 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` / `test:errors` / `test:client` / `test:host` / `test:package` | 分项测试 |
| `npm run check` | 以上全部串跑 |
| `npm run pack:local` | 构建并生成 `artifacts/*.tgz` |

### 开发热重载

在源码检出（存在 `src/index.ts`）中，`npm run dev` 会在构建后原位替换插件的 Cordis fiber。它只监视服务端入口 `dist/index.js` 与 `dist/ledger-worker.js`，浏览器入口的改动仍需刷新页面。重载会等待在途推理完成，释放旧 fiber 的数据库 worker、watcher 与定时器；导入失败时回滚旧缓存与旧注册。安装包不含 `src/`，生产安装不会启用；首次启用需重启一次 DSH，`CHANNEL_HUB_HOT_RELOAD=0` 可关闭。

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 数据根目录，默认 `~/.dsh` |
| `DSH_PROFILE` | 未取到 profile 上下文时的缺省 profile 名 |
| `DSH_ASAR` | `extract-host.mjs` 使用的宿主 `app.asar` 路径 |
| `CHANNEL_HUB_HOT_RELOAD` | `0` 关闭开发热重载 |
| `CHANNEL_HUB_SOURCEMAPS` | `1` 为构建产物生成 sourcemap |
| `DSH_CHANNEL_HUB_STORE_TIMEOUT_MS` | 账本单次调用超时，默认 5000 |
| `DSH_CHANNEL_HUB_STORE_MAX_PENDING` | 未完成账本调用上限，默认 200 |

### 仓库结构

```
src/
  index.ts      插件生命周期、profile 路径、凭据命名空间、RPC 路由
  drivers/      各渠道驱动的装配（认证 / 目录 / 推理 / 额度 / 领取）
  core/         请求上下文、统一指标、目录快照、额度、签到、续期、折扣判据
  storage/      SQLite 工作线程与客户端
  client.ts     浏览器入口（渠道 / 看板 / 日志三页）
  reload.ts     开发期原位重载
vendor/         固定版本的上游快照，改动逐条记账
tests/          夹具测试；不联网、不读真实账号
scripts/        构建、宿主提取、打包与校验
docs/           架构、验收记录、布局方案
```

`dist/` 是构建产物，用 `npm run build` 更新，不手工修改。

### vendor 策略

认证与账号池以本地 OFM 快照为基准，`vendor/` 只跟随真实 import 图打包，不加载上游的入口、RPC 或网关。上游差异按月审查、按问题移植，不做全量合并。每处本地改动的原因与验证方式记录在[验收记录](docs/ACCEPTANCE.md)，基线提交见[架构说明](docs/ARCHITECTURE.md#来源策略)。

## 文档

- [架构说明](docs/ARCHITECTURE.md)：模块边界、数据流、RPC 方法组、vendor 来源与本地改动。
- [验收记录](docs/ACCEPTANCE.md)：每项改动的原因、验证方式与真实账号结论。
- [布局方案](docs/LAYOUT.md)：渠道页布局的实测数据与取舍。

## 反馈与贡献

欢迎提交 issue 与 PR：

- 不要提交真实凭据、数据库或运行日志。排查问题时请先脱敏令牌、Cookie、邮箱与账号 id。
- 改动 `vendor/` 时，请在 PR 中说明改动原因，并附验证方式。
- 新增渠道或修改认证协议前，先阅读[架构说明](docs/ARCHITECTURE.md)。
- 提交前运行 `npm run check`；只改界面时至少运行 `npm run test:client`。

安全问题请通过私密渠道反馈，不要开公开 issue。

## 致谢

认证协议与账号池来自以下上游项目，本项目只做固定快照与按问题移植：

- [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
- [chengshenyangtai/dsh-workbuddy-trae-qoder-connect](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect)
- [iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)（Qoder 目录解析参考）

本项目为非官方插件，与上述渠道厂商无隶属关系；使用各渠道服务时应遵守其服务条款。

## 许可证

[MIT](LICENSE)
