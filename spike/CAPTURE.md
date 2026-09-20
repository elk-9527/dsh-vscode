# M0 结论：`dsh --profile acp` 实测报告

> 本文只记录**实测得到的事实**，不记录推断。每条结论均可用 `spike/` 下的脚本复现。
> 复现方式：`node spike/acp-probe.mjs --edit`、`node spike/acp-capabilities.mjs`、`node spike/acp-verify.mjs`
> 原始帧位于 `spike/capture/*-frames.jsonl`（已列入 gitignore，因为其中含文件内容）。

测试环境：Windows 11 / Node v24.16.0 / DSH Desktop 2.0.10 / `@agentclientprotocol/sdk` 1.4.0 / `DSH_HOME=$DSH_HOME`
ACP 面：`agentInfo = { name: "deepseek-harness-acp", version: "0.0.1" }`，`protocolVersion = 1`

---

## 一、启动方式：Windows 上需要绕开 `dsh.cmd`

`where dsh` 返回的是批处理 shim：

```bat
set "ELECTRON_RUN_AS_NODE=1"
set "DSH_DESKTOP_DEFAULT_PROFILE=desktop"
set "DSH_HOME=$DSH_HOME"
"<DSH Desktop 安装目录>\DSH Desktop.exe" --expose-internals "<DSH Desktop 安装目录>\resources\app\lib\desktop-cli.js" %*
```

**结论：解析该 shim，直接 spawn exe + `desktop-cli.js`，并复刻三个环境变量。**
不采用 `spawn('dsh.cmd')`（Node 不能直接执行批处理，`shell:true` 还需要经过一层 cmd.exe 的引号处理）。
实现见 `spike/lib/dsh-spawn.mjs` 的 `locateDsh()`，实测稳定。

`acp` / `web` / `sdk` 三个 profile 模板**随 DSH 自带**，首次执行 `dsh --profile acp` 会从内置模板写入到 `$DSH_HOME/profiles/acp`（`dsh-acp-app` patch 层），**不需要仓库源码，不需要 pnpm**。

---

## 二、能力矩阵：实际实现的 ACP 方法

`@agentclientprotocol/sdk` 的 `methods` 表是**整个 ACP 规范**的方法表，不代表 DSH 已实现其中全部方法。
实测手法：使用不存在的 sessionId 调用写操作 —— 返回 `-32601` 即表示未实现。

| 方法 | 结果 | 证据 |
|---|---|---|
| `initialize` | ✅ | `protocolVersion=1` |
| `session/new` | ✅ | 返回 `sessionId` + `configOptions` |
| `session/list` | ✅ | **支持 `cwd` 过滤**（实测按目录筛出 5 条） |
| `session/resume` | ✅ | 返回 `{configOptions}`；注意**不返回 sessionId** |
| `session/close` | ✅ | 关闭探针自己的会话成功 |
| `session/set_config_option` | ✅ | 见第四节 |
| `session/prompt` | ✅ | `stopReason=end_turn` |
| `document/didFocus` / `didOpen` / `didChange` | ⚠️ 通知被接受，无错误响应 | 通知没有回执，证据偏弱，M2 进一步确认 |
| `session/cancel` | ⛔ **未实现** | `-32601 "Method not found": session/cancel` |
| `session/set_mode` | ⛔ 未实现 | `-32601` |
| `session/load` | ⛔ 未实现 | `-32601` |
| `session/fork` | ⛔ 未实现 | `-32601` |
| `session/delete` | ⛔ 未实现 | `-32601` |
| `providers/list` | ⛔ 未实现 | `-32601` |

`initialize` 公布的 capability：
```json
{"mcpCapabilities":{"http":true},
 "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},
 "sessionCapabilities":{"close":{},"list":{},"resume":{}}}
```

**推论（纳入设计）：**
- 会话 UI 只实现 **新建 / 列表 / 恢复 / 关闭**，不实现 fork、删除、回放。
- `promptCapabilities.image=false` → **不能通过 ACP 发送图片**。"图片粘贴"从 M5 的加分项变为需要在绕行与放弃之间选择。
- `embeddedContext=false` → 上下文需要自行拼接为文本，不能依赖协议将编辑器内容结构化传入。

---

## 三、模型路由：默认路由不可用，切换通过运行时调用

`acp` profile 将每个新会话固定为 `deepseek-official/deepseek-v4-flash`，而**本机该路由的 key 无效**：

```
RequestError code=-32603: Internal error: turn failed: Authentication Fails, Your api key: ****K5ba is invalid
```

可用路由是 `opencode-go/deepseek-v4.1-flash`（桌面端当前使用的路由），且它**就在会话的 configOptions 里**：

```jsonc
{ "id":"model", "category":"model", "type":"select",
  "currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]",   // ← 注意：该值为 JSON 元组的字符串
  "options":[
    { "group":"deepseek-official", "options":[ deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp ] },
    { "group":"opencode-go",       "options":[ deepseek-v4.1-flash ] } ]}
```

**结论：模型选择通过 `session/set_config_option` 完成，不需要修改任何配置文件、不修改 `~/.dsh`。**
```js
await ctx.request(acp.methods.agent.session.setConfigOption,
  { sessionId, configId: 'model', value: '["opencode-go","deepseek-v4.1-flash"]' });
```

### 三个需要记录的要点

1. **切换模型后需要重新读取配置状态，`reasoning_effort` 会完全消失。**
   `deepseek-official` 路由公布 `off/low/high/max`；切换到 `opencode-go/deepseek-v4.1-flash` 后，
   返回的 configOptions 中**不包含 `reasoning_effort`**，强行设置 `low` 会被拒绝：
   `Invalid params: unknown reasoning effort for opencode-go/deepseek-v4.1-flash: low`。
   → UI 需要将 configOptions 视为**易变状态**，每次变更后整体替换，不缓存、不硬编码选项。

2. **模型选择是 per-session 的，恢复会话后需要重新应用。**
   `session/resume` 只返回 `{configOptions}`，新会话中切换过的模型不会延续 ——
   实测恢复后直接提问，再次出现 `deepseek-official` 的鉴权错误。
   → 扩展需要持久化用户选择的模型，在**每次 new 与 resume 之后**都重放一次。

3. `ClientContext` 只有 `buildSession` / `request` / `notify`。
   所有会话级方法（`set_config_option`、`cancel`、`close`…）都通过 `ctx.request(method, params)` 调用。

---

## 四、停止按钮使用 `AbortSignal`，不使用 `session/cancel`

`session/cancel` 未实现，但 SDK 的 `SendRequestOptions` 提供了可行的途径：

> `cancellationSignal?: AbortSignal` —— Aborting this signal sends `$/cancel_request` for the outgoing request.

实测：
```js
const ac = new AbortController();
session.prompt('请写一篇 3000 字的中文散文…', { cancellationSignal: ac.signal });
setTimeout(() => ac.abort(), 1200);
```
```
✅ AbortSignal 能中断回合  — {"stopReason":"cancelled","ms":1218}
✅ 中断后同一会话仍可用  — {"stopReason":"end_turn"}
```
**结论：停止按钮使用 AbortController；中断过程是干净的，会话可以继续使用。**
（`$/cancel_request` 在 SDK 方法表里是 `protocol.cancelRequest`。）

---

## 五、diff 的数据源是 `rawInput`，不是 ACP

**该结论推翻了原计划的假设。** ACP v1 规范中 `ToolCallContent` 确实有 `{type:"diff", path, oldText, newText}`，
但 **DSH 的 edit 工具不发送该内容**。实测一轮真实文件修改，`trace: diff 数 = 0`。

DSH 实际发出来的是（原始帧，已精简）：

```jsonc
// 1) 工具开始
{"sessionUpdate":"tool_call","toolCallId":"call_00_ET_j…","title":"edit","kind":"other",
 "status":"in_progress",
 "rawInput":{"file_path":"D:\\…\\hello.ts",
             "old_string":"export function greet(name: string): string {",
             "new_string":"/** … */\nexport function greet(name: string): string {"}}
// 2) 工具结束
{"sessionUpdate":"tool_call_update","toolCallId":"call_00_ET_j…","status":"completed",
 "content":[{"type":"content","content":{"type":"text","text":"The file D:\\…\\hello.ts has been updated successfully."}}]}
```

**结论（M3 的核心改动）：原生 diff 从 `rawInput` 构造。**
- `rawInput.file_path` + `old_string` → `new_string` 即精确到字符串的 diff，足以传给
  `TextDocumentContentProvider` + `vscode.diff` 实现左右对照。
- `kind` 一律为 `"other"`，**不能使用 ACP 的 kind 分类**；需要依据 `title`（工具名 `read`/`edit`/…）自行映射。
- **不提供 `locations`**，路径只能从 `rawInput` / 工具输出文本中取得。
- `read` 工具的输出包在 `<path>/<type>/<content>` 文本中，行号带前缀 —— 需要自行解析。

一项额外结论：`title:"edit"` 的 `rawInput` 结构与 DM010727/dsh-cline 通过内核 `tools/pre-execute` 钩子取得的数据一致 ——
**该方案需要一个内核插件，本方案通过 ACP 直接取得。**

---

## 六、流式更新的实际形状

一轮真实对话（opencode-go，2 回合，共 11 条更新）中观察到的类型：

| `sessionUpdate` | 说明 |
|---|---|
| `agent_message_chunk` | assistant 正文增量，`content.type === "text"` |
| `agent_thought_chunk` | 思考增量（推理强度高时出现） |
| `tool_call` | 工具开始：`toolCallId` / `title` / `kind` / `status` / `rawInput` |
| `tool_call_update` | 工具进展与结束：`status` / `content[]`（同为 `toolCallId`，可能**重复推送同一项**）|
| `usage_update` | `{used: 11512, size: 262144}` —— 现成的上下文占用条，不需要自行计算 |
| `plan` / `user_message_chunk` / `config_option_update` … | 本轮未出现，M1 遇到时再处理 |

细节：`tool_call_update` 的 `completed` 状态**被推送两次**（内容相同）→ 前端需要按 `toolCallId` 幂等合并。
未知类型需要**忽略而非抛错**，否则 DSH 升级会导致失败。

---

## 七、会话与更新路由：不能只使用 `ActiveSession`

SDK 的 `buildSession()/ActiveSession` 只覆盖 `session/new`。
`session/resume` 没有对应的 helper（`ClientContext.attachSession` 为 private）。

实测可行的做法：在连接级别使用 `onNotification(acp.methods.client.session.update, …)` **全局订阅，按 `sessionId` 分流**：
```
✅ session/resume 成功  — {"keys":["configOptions"]}
✅ 恢复后能继续对话（全局更新路由生效）
```
→ `packages/acp` 需要自行实现会话注册表（new + resume 统一路径），而不是封装一层 `ActiveSession`。
（2026-09-20 记录：`packages/acp` 的空壳目录已删除 —— 结论落在扩展一侧，
会话注册表位于 `packages/vscode-extension/src/dsh/session.js`。）

---

## 八、给 M1 的确定结论（可立即实施的清单）

| 事项 | 结论 |
|---|---|
| 启动 | 解析 `dsh.cmd` → 直接 spawn exe + `--expose-internals desktop-cli.js --profile acp` |
| 协议 | 使用官方 `@agentclientprotocol/sdk@1.4.0`（带 `.d.ts`，类型齐全） |
| 会话 | 自建注册表；支持 new / list(cwd) / resume / close；不支持 fork/delete/load |
| 模型 | 每次 new/resume 后重放用户选择；configOptions 视为易变状态，每次响应整体替换 |
| 停止 | `AbortController` → 自动发送 `$/cancel_request`；实测 `stopReason=cancelled` |
| diff | 从 `tool_call.rawInput.{file_path,old_string,new_string}` 构造；**不等待 `type:"diff"`** |
| 工具分类 | 使用 `title` 映射，`kind` 恒为 `other`，`locations` 缺失 |
| 上下文占用 | 直接使用 `usage_update` 的 `used/size` |
| 图片 | `promptCapabilities.image=false`，ACP 无法发送图片 |
| 幂等 | 同一 `toolCallId` 的更新会重复推送，按 id 合并 |
| 前进兼容 | 未知 `sessionUpdate` / 未知错误码一律降级忽略，不抛错 |

---

## 九、给方案的修正

1. **M3「原生 diff」的原假设需要修改**：数据源是 `rawInput` 而非 ACP diff 内容块。结论不变（能够实现 Cline 式 diff），
   但实现更简单 —— 不需要在工具执行前拦截，`tool_call` 一到达即带有 `old_string`/`new_string`。
2. **M2 增加一条硬性要求**：持久化"用户选择的模型"，new/resume 后重放。否则恢复会话必然出现鉴权错误。
3. **图片粘贴从 M5 降级/剔除**（协议层无法发送图片）。
4. **停止按钮的实现路径已明确**，M1 即可实现，不需要等到 M3。
