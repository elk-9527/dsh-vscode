# M0 结论：`dsh --profile acp` 实测报告

> 本文只写**实测得到的事实**，不写推断。每条结论都能用 `spike/` 下的脚本复现。
> 复现方式：`node spike/acp-probe.mjs --edit`、`node spike/acp-capabilities.mjs`、`node spike/acp-verify.mjs`
> 原始帧落在 `spike/capture/*-frames.jsonl`（已 gitignore，因为含文件内容）。

测试环境：Windows 11 / Node v24.16.0 / DSH Desktop 2.0.10 / `@agentclientprotocol/sdk` 1.4.0 / `DSH_HOME=C:\Users\Lenovo\.dsh`
ACP 面：`agentInfo = { name: "deepseek-harness-acp", version: "0.0.1" }`，`protocolVersion = 1`

---

## 一、启动方式：Windows 上必须绕开 `dsh.cmd`

`where dsh` 拿到的是批处理 shim：

```bat
set "ELECTRON_RUN_AS_NODE=1"
set "DSH_DESKTOP_DEFAULT_PROFILE=desktop"
set "DSH_HOME=C:\Users\Lenovo\.dsh"
"D:\Program Files\DSH Desktop\DSH Desktop.exe" --expose-internals "D:\Program Files\DSH Desktop\resources\app\lib\desktop-cli.js" %*
```

**结论：解析这个 shim，直接 spawn exe + `desktop-cli.js`，并复刻三个环境变量。**
不要用 `spawn('dsh.cmd')`（Node 不能直接执行批处理，`shell:true` 又要过一层 cmd.exe 的引号地狱）。
实现见 `spike/lib/dsh-spawn.mjs` 的 `locateDsh()`，实测稳定。

`acp` / `web` / `sdk` 三个 profile 模板**随 DSH 自带**，首次 `dsh --profile acp` 会从内置模板落盘到 `$DSH_HOME/profiles/acp`（`dsh-acp-app` patch 层），**不需要仓库源码，不需要 pnpm**。

---

## 二、能力矩阵：哪些 ACP 方法真的实现了

`@agentclientprotocol/sdk` 的 `methods` 表是**整个 ACP 规范**的方法表，不代表 DSH 实现了。
实测手法：用不存在的 sessionId 调写操作 —— `-32601` 就是"没实现"。

| 方法 | 结果 | 证据 |
|---|---|---|
| `initialize` | ✅ | `protocolVersion=1` |
| `session/new` | ✅ | 返回 `sessionId` + `configOptions` |
| `session/list` | ✅ | **支持 `cwd` 过滤**（实测按目录筛出 5 条） |
| `session/resume` | ✅ | 返回 `{configOptions}`；注意**不返回 sessionId** |
| `session/close` | ✅ | 关闭探针自己的会话成功 |
| `session/set_config_option` | ✅ | 见第四节 |
| `session/prompt` | ✅ | `stopReason=end_turn` |
| `document/didFocus` / `didOpen` / `didChange` | ⚠️ 通知被接受，无错误响应 | 通知没有回执，证据偏弱，M2 再深挖 |
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

**推论（写进设计）：**
- 会话 UI 只做 **新建 / 列表 / 恢复 / 关闭**，不做 fork、删除、回放。
- `promptCapabilities.image=false` → **不能通过 ACP 发图片**。"图片粘贴"从 M5 的加分项变成"要么绕路、要么放弃"。
- `embeddedContext=false` → 上下文要自己拼成文本，不能靠协议把编辑器内容结构化送进去。

---

## 三、模型路由：默认那条是坏的，切换是运行时调用

`acp` profile 把每个新会话钉死在 `deepseek-official/deepseek-v4-flash`，而**本机这条路由的 key 无效**：

```
RequestError code=-32603: Internal error: turn failed: Authentication Fails, Your api key: ****K5ba is invalid
```

可用路由是 `opencode-go/deepseek-v4.1-flash`（桌面端正在用的那条），而它**就在会话的 configOptions 里**：

```jsonc
{ "id":"model", "category":"model", "type":"select",
  "currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]",   // ← 注意是 JSON 元组的字符串
  "options":[
    { "group":"deepseek-official", "options":[ deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp ] },
    { "group":"opencode-go",       "options":[ deepseek-v4.1-flash ] } ]}
```

**结论：模型选择是 `session/set_config_option`，不需要改任何配置文件、不碰 `~/.dsh`。**
```js
await ctx.request(acp.methods.agent.session.setConfigOption,
  { sessionId, configId: 'model', value: '["opencode-go","deepseek-v4.1-flash"]' });
```

### 三个必须记住的坑

1. **切换模型后必须重新读配置状态，`reasoning_effort` 会整个消失。**
   `deepseek-official` 路由广告 `off/low/high/max`；切到 `opencode-go/deepseek-v4.1-flash` 后，
   返回的 configOptions 里**根本没有 `reasoning_effort`**，硬设 `low` 会被拒：
   `Invalid params: unknown reasoning effort for opencode-go/deepseek-v4.1-flash: low`。
   → UI 必须把 configOptions 当**易变状态**，每次变更后整体替换，绝不缓存、绝不硬编码选项。

2. **模型选择是 per-session 的，恢复会话后要重新应用。**
   `session/resume` 只返回 `{configOptions}`，新会话里切过的模型不会跟过去 ——
   实测恢复后直接提问，又撞上 `deepseek-official` 的鉴权错误。
   → 扩展要持久化用户选的模型，在**每次 new 和 resume 之后**都重放一次。

3. `ClientContext` 只有 `buildSession` / `request` / `notify`。
   所有会话级方法（`set_config_option`、`cancel`、`close`…）都走 `ctx.request(method, params)`。

---

## 四、停止按钮 = `AbortSignal`，不是 `session/cancel`

`session/cancel` 未实现，但 SDK 的 `SendRequestOptions` 提供了正路：

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
**结论：停止按钮用 AbortController；中断是干净的，会话可继续用。**
（`$/cancel_request` 在 SDK 方法表里是 `protocol.cancelRequest`。）

---

## 五、diff 的数据源不是 ACP，而是 `rawInput`

**推翻了原计划的假设。** ACP v1 规范里 `ToolCallContent` 确实有 `{type:"diff", path, oldText, newText}`，
但 **DSH 的 edit 工具不发它**。实测一轮真实改文件，`trace: diff 数 = 0`。

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
- `rawInput.file_path` + `old_string` → `new_string` 就是精确到字符串的 diff，足够喂给
  `TextDocumentContentProvider` + `vscode.diff` 做左右对照。
- `kind` 一律是 `"other"`，**不能用 ACP 的 kind 分类**；要靠 `title`（工具名 `read`/`edit`/…）自己映射。
- **不提供 `locations`**，路径只能从 `rawInput` / 工具输出文本里取。
- `read` 工具的输出包在 `<path>/<type>/<content>` 文本里，行号带前缀 —— 要自己解析。

一个额外收获：`title:"edit"` 的 `rawInput` 结构与 DM010727/dsh-cline 靠内核 `tools/pre-execute` 钩子拿到的数据一致 ——
**它需要一个内核插件，我们通过 ACP 白拿。**

---

## 六、流式更新的真实形状

一轮真实对话（opencode-go，2 回合，共 11 条更新）观察到的类型：

| `sessionUpdate` | 说明 |
|---|---|
| `agent_message_chunk` | assistant 正文增量，`content.type === "text"` |
| `agent_thought_chunk` | 思考增量（推理强度高时出现） |
| `tool_call` | 工具开始：`toolCallId` / `title` / `kind` / `status` / `rawInput` |
| `tool_call_update` | 工具进展与结束：`status` / `content[]`（同为 `toolCallId`，可能**重复推送同一条**）|
| `usage_update` | `{used: 11512, size: 262144}` —— 现成的上下文占用条，不用自己算 |
| `plan` / `user_message_chunk` / `config_option_update` … | 本轮没出现，M1 遇到再处理 |

细节：`tool_call_update` 的 `completed` 状态**被推了两次**（内容相同）→ 前端必须按 `toolCallId` 幂等合并。
未知类型要**忽略而不是抛错**，否则 DSH 升级就会炸。

---

## 七、会话与更新路由：不要只用 `ActiveSession`

SDK 的 `buildSession()/ActiveSession` 只覆盖 `session/new`。
`session/resume` 没有对应的 helper（`ClientContext.attachSession` 是 private）。

实测可行的做法：在连接级别 `onNotification(acp.methods.client.session.update, …)` **全局订阅，按 `sessionId` 分流**：
```
✅ session/resume 成功  — {"keys":["configOptions"]}
✅ 恢复后能继续对话（全局更新路由生效）
```
→ `packages/acp` 要自己实现会话注册表（new + resume 统一路径），而不是包一层 `ActiveSession`。

---

## 八、给 M1 的确定结论（可直接开工的清单）

| 事项 | 结论 |
|---|---|
| 启动 | 解析 `dsh.cmd` → 直接 spawn exe + `--expose-internals desktop-cli.js --profile acp` |
| 协议 | 用官方 `@agentclientprotocol/sdk@1.4.0`（带 `.d.ts`，类型齐全） |
| 会话 | 自建注册表；支持 new / list(cwd) / resume / close；不支持 fork/delete/load |
| 模型 | 每次 new/resume 后重放用户选择；configOptions 当易变状态，每次响应整体替换 |
| 停止 | `AbortController` → 自动发 `$/cancel_request`；实测 `stopReason=cancelled` |
| diff | 从 `tool_call.rawInput.{file_path,old_string,new_string}` 构造；**不要等 `type:"diff"`** |
| 工具分类 | 用 `title` 映射，`kind` 恒为 `other`，`locations` 缺失 |
| 上下文占用 | 直接用 `usage_update` 的 `used/size` |
| 图片 | `promptCapabilities.image=false`，ACP 发不了图 |
| 幂等 | 同一 `toolCallId` 的更新会重复推，按 id 合并 |
| 前进兼容 | 未知 `sessionUpdate` / 未知错误码一律降级忽略，不抛 |

---

## 九、给方案的修正

1. **M3「原生 diff」的原假设要改**：数据源是 `rawInput` 而非 ACP diff 内容块。结论不变（能做出 Cline 式 diff），
   但实现更简单 —— 不需要在工具执行前拦截，`tool_call` 一到达就有 `old_string`/`new_string`。
2. **M2 增加一条硬要求**：持久化"用户选的模型"，new/resume 后重放。否则恢复会话必踩鉴权错。
3. **图片粘贴从 M5 降级/剔除**（协议层发不了图）。
4. **停止按钮的实现路径明确**，M1 就能做，不必等 M3。
