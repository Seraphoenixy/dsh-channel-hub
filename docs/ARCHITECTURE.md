# 架构与维护边界

## 模块

- `src/index.ts`：DSH 生命周期、profile 路径、凭据引用命名空间、鉴权连接中的版本化 RPC。
- `src/drivers/`：OFM 认证/账号池与各渠道驱动的装配；Gemini 动态发现补充。
- `src/core/`：请求上下文、物理尝试、统一指标、目录快照与续期调度；`rate.ts` 只做各驱动计费系数的展示归一化（不按时间窗口推算）并把活动时段/角标整理成独立文案，缺失不补值；`promotion.ts` 在**已有的** `/v3/config` 响应上补出折扣时段与角标（不新增端点，vendor 快照哈希不变）；`credits.ts` 把各渠道额度响应归一成 `{ label, progress, packages, error }` 的展示读数（读数文案在宿主拼好，浏览器只画；查不到不显示成 0，token 与积分不合并，面值未知不补 100%）。
- `src/storage/`：数据库工作线程；请求明细与日汇总在同一事务终结。
- `src/migration.ts`：只读旧数据、格式转换、幂等导入与模型偏好合并。
- `src/reload.ts`：仅开发检出的模块缓存清理、原位重载与目录监视；不改变 RPC 或安装布局。
- `src/client.ts`：构建为唯一浏览器入口，渠道、看板、日志三个页面；样式取自宿主的 `--dsw-alias-*` 主题变量，不引入独立配色或全局选择器。

渠道的认证、目录、推理、额度与领取分开调用。目录读取不能触发选号，也不能覆盖正在生成的账号归属。宿主调用通过 prepareCall 包装，不能只测试 stream 方法。CodeBuddy CN 与 WorkBuddy 国区共用 `buddy` 渠道，不设其他别名。

## 数据流

DSH prepareCall → 请求执行 → 显式选号 → 上游尝试 → 标准流事件。

请求 AsyncLocalStorage 保存本次请求和服务账号；上游 fetch 包装在实际调用点创建尝试，读取标准 usage 并保留失败消耗。已向调用方输出后禁止透明重放。数据库故障不改模型结果，但显示记录异常。

SQLite 表包含 requests、attempts、daily 和 kv。daily 的空账号行用于逻辑请求与全局汇总，非空账号行用于账号透视；两类行不能混加。永久保存统计所需的和与样本数，避免平均值再平均。

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
