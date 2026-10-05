# DSH IDE Bridge v1

协议使用现有本机 NDJSON / JSON-RPC 连接，ACP 对话、权限、历史和流式输出保持原协议。
版本协商来自 `dsh-door/status.capabilities.bridge.protocolVersion`，缺席时原生能力入口降级，聊天继续可用。

## 方法

| 方法 | 输入 | 输出 | 鉴权 |
| --- | --- | --- | --- |
| `dsh-door/bridge/catalog` | 空对象 | `protocolVersion`、`revision`、`capabilities` | 无 |
| `dsh-door/bridge/auth` | `instanceId`、`bootstrapToken`、`clientId` | `expiresAt` | 引导密钥 |
| `dsh-door/bridge/invoke` | `requestId`、`capabilityId`、`input`、`context` | `mode: immediate/value` 或 `mode: operation/operationId/acceptedAt` | 有 |
| `dsh-door/bridge/operation/get` | `operationId`、可选 `afterSeq` | 状态、递增 `seq`、事件、可选最终 `result`、`gap` | 有 |
| `dsh-door/bridge/cancel` | `operationId` | 当前运行快照 | 有 |

`dsh-door/bridge/event` 通知包含 `operationId`、`seq`、`type`、`at` 和 `payload`。
类型为 `started`、`progress`、`artifact`、`completed`、`failed`、`cancelled`。
新增可忽略通知 `dsh-door/bridge/catalog-changed`，载荷为 `revision`，仅通知已经鉴权的连接。

`context` 包含绝对 `cwd`、可选 `sessionId`、`workspaceTrusted` 和 `userInitiated`。
写入及系统能力另需 `approved`。各提供方仍须校验自身资源和输入。
`requiresSession` 能力只能使用当前 TCP 连接创建或恢复的 Agent；工作目录需与会话真实目录一致。

## 提供方

插件通过可选 Cordis 注入 `ideBridge`，调用 `registerProvider({ id, name, version, capabilities, invoke })`。
返回释放函数；插件卸载时移除其能力并终止对应运行。其他入口继续调用插件现有业务逻辑。
目录只接受声明性数据，不提供任意命令、HTML、脚本或内部 HTTP 路由调用。

能力声明包含 `id`、`title`、`kind`、`riskTier`、`effects`、`requiresSession`、`supportsCancellation`、`inputSchema` 和 `outputKinds`。
`kind` 为 `resource`、`action` 或 `workflow`；风险为 `read`、`execute`、`workspace-write` 或 `system`。
参数规则仅支持源码验证器显式实现的 JSON Schema 子集，未知规则拒绝注册。

## 鉴权和恢复

接入点监听成功后生成 `$DSH_HOME/run/dsh-acp-door/<实际端口>.json`。
文件使用随机密钥、随机实例标识、PID、启动时间和实际端口。POSIX 权限为 0600；Windows 移除继承，文件仅授予当前账户及 SYSTEM。
客户端核对实例、端口和进程，使用稳定的工作区 `clientId` 获取 15 分钟租约，第 12 分钟续期。
凭据内容、原始提供方异常和鉴权请求不会进入目录或业务错误。

操作归属于已鉴权的 `clientId`，重连后相同身份可以查询最终结果；不同身份无法读取运行记录。
同一 `requestId` 在十分钟内返回相同结果；重用标识但修改参数返回输入错误。
连接断开不发送取消请求。运行结束保留三十分钟；每个运行最多保留 200 个事件或 2 MiB。
ACP 连接作用域延迟到该连接的插件任务结束后释放，避免断线提前销毁审查 Agent。
编辑器自启内核带 `DSH_BRIDGE_OWNED_IDLE_MS`，无连接且任务结束后按宽限期自行退出；桌面端不设置此变量。
VS Code 关闭时保留有任务的自启内核，稳定工作区身份和运行标识用于重新打开窗口后的恢复。
恢复要求原内核仍存活且记录未过期；内核重启后不能恢复内存中的运行结果。
事件被压缩后，查询返回 `gap: true` 和最新状态，客户端不能把缺失的中间事件视为完整历史。
输入、输出或单事件上限为 1 MiB；全内核并发最多 32 个运行，未过期记录最多 1000 项。

## 错误

`-32040` 版本不兼容；`-32041` 未鉴权或租约过期；`-32042` 身份材料无效；
`-32043` 能力缺失；`-32044` 风险策略禁止；`-32045` 运行互斥或数量超限；
`-32046` 参数及上下文无效；`-32047` 记录不存在或过期；`-32048` 提供方执行失败；`-32049` 数据超限。
界面使用简短说明，不直接向用户展示数字码。提供方执行失败记录使用 `provider-failed`，卸载使用 `provider-unloaded`。

## 首版试点和安装来源

Code Review `0.1.9-ide.1` 从上游 `0.1.9` 发行包生成；Skill Explorer `0.4.4-ide.2` 从上游 `0.4.4` 生成。
注册补丁在 `tools/bridge/providers/`，审查输出格式补丁在 `tools/bridge/review-runtime.cjs`。
生成脚本检查上游入口及审查执行器 SHA-256 后复制到构建目录并打包，不修改装机文件。
保留上游许可证、桌面 UI、命令和工具入口。上游发行包不含完整构建源码，因此候选打包显式关闭 prepack，使用已校验发行物加可审查的注册补丁。
原版审查入口使用自然语言报告；Bridge 调用单独启用现有 JSON rubric，原版入口维持原有格式。
能力 ID 为 `michengai.code-review.run`、`linxin.skill-explorer.list/read/health`。

## 扩展 API 首版

主扩展 `activate()` 返回 `apiVersion: 1`、`listCapabilities()`、`getConnectionStatus()` 和 `review({cwd,input,userInitiated})`。
`review` 要求受信任工作区、工作区内目录及显式 `userInitiated: true`，使用独立审查会话，避免与聊天会话争用。
文件变更快照不一致时报告标记过期，不向 Problems 投影旧位置；保存关联文件时清除已有诊断。
API 是首版调用入口，Chat 伴生扩展、第三方 SDK 和技能写操作另属后续阶段。

实现状态与真实环境证据另见验收记录；协议文档不构成支持或安装成功证明。
