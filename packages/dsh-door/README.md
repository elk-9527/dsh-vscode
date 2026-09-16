# dsh-acp-door

在**正在运行的** DeepSeek Harness 内核上额外开一扇 **ACP 门**（只监听 `127.0.0.1`），
让外部程序（VS Code 面板）能驱动**同一个** DSH —— 同一套配置、同一份记忆、
同一套工具、同一份会话记录。

## 它解决什么问题

ACP 默认走「标准输入输出」：那根线只能在进程**启动的那一刻**接上。
而你已经把 DSH Desktop 开着在用了，外部程序没办法把线插进去。

但 DSH 自带的 ACP 插件支持**注入传输层**（其源码里写着）：

```js
const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
```

所以本插件做的唯一一件事是：**每个 TCP 连接上，再挂一份 ACP 桥**。

```
DSH Desktop（已在跑）
├── 内核：agents / llm / sessions / 工具 / 记忆 / 技能      ← 只有一份
├── 网页界面                                     （原有）
└── 本插件：127.0.0.1:47821  ── 每个连接 = 一份 ACP 桥      （新增）
```

## 为什么还要替会话「补挂预设」

这是本插件除了开端口之外**唯一**做的实事，也是最容易踩空的地方，所以单独说清楚。

桌面端 / 网页端架构把**宿主层**的工具全部停用了 —— `dsh-web-app` 的补丁里：

```yaml
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
```

它的注释说明了理由：*"the Web surface disables them here and
**lets each session mount a preset instead**"* —— 也就是说，工具改成了
**每个会话按 agent preset 挂一套**。

而 `@deepseek-ai/dsh-acp` 建 agent 时只传了工作目录、**从不点名预设**
（`dsh-acp/lib/index.js` 的 `AcpSession.create` 里 `meta: { cwd }`）。
两边一凑，走 ACP 的会话就掉进缝里：**宿主层没有工具，预设层也没人给它指定** ——
一个「有嘴没手」的 agent（它会说「我来读一下这个文件」，然后什么也做不了）。

内核自己的报错文案指明了正道：

> `(join through AgentPresets.mount() or composeFrom() in the agent factory setup)`

所以本插件监听 `agent/created`，用公开的 `agentPresets.select(agent, id)`
补上这一步。它会把该 agent 的作用域重新组装，并把这次选择**记进会话记录** ——
因此之后在桌面端打开这个会话，它显示的预设也是对的。

### 两个必须注意的坑（都实测踩过）

1. **`agentPresets` 必须写成声明式依赖。** cordis 的服务代理对未声明的属性
   **直接抛**（`cannot get property "…" without inject`）。而这个异常发生在内核
   创建 agent 的**同步**流程里：要么打断 `session/new`，要么被 async 吞掉、
   让门**假装在工作**。所以它进了 `inject`，缺这个服务的 profile 会直接不启动这扇门。

2. **有一道竞态，必须用入站闸挡住。** 内核派发 `agent/created` 时**不等待**
   监听器返回的 promise，于是「补挂预设」和「客户端发第一个 prompt」是并行的。
   实测数据（诊断日志原文）：

   | 时刻 | 事件 |
   |---|---|
   | `37.169` | `agent/created` 触发 |
   | `37.224` | 客户端 prompt 到达（**+55ms**） |
   | `37.526` | 预设挂载完成（耗时 **357ms**） |

   客户端跑赢了，于是模型收到 **0 个工具 schema**（会话记录里 `toolsTokens: 0`），
   只能把工具调用当文本写出来。因此 {@link gatePrompts} 在传输层把该会话的
   `session/prompt` 按住，直到挂载落定 —— 上表那一轮实际压了 303ms。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。**不要改成 `0.0.0.0`**，那会把门开到局域网上。 |
| `port` | `47821` | 监听端口；传 `0` 让系统挑空闲端口。 |
| `provider` | — | 新会话的初始模型服务商。 |
| `model` | — | 新会话的初始模型名。 |
| `preset` | `standard` | 新会话挂载的 agent preset：`standard`（标准）/ `ptc` / `cordis`（创造）/ `minimal`（极简）。 |
| `diagLog` | 关 | 诊断日志文件路径；也可用环境变量 `DSH_ACP_DOOR_DIAG`。排查时序问题用，不配则完全不写文件。 |

## 怎么装

**必须用 `npm pack` 的产物安装，不要直接指向源码目录。** 因为本插件要
`import '@deepseek-ai/dsh-acp'`，而那是 DSH 内部自带的包、不在 npm 上；
直接指向目录时 Node 会从源码目录往上找，找不到那个包。装成 tgz 后它落在
profile 里，就能顺着 `profiles/node_modules` 找到 DSH 自己的包。

```powershell
cd <本目录>
npm pack
dsh plugin --profile <profile> add "file:<本目录>\dsh-acp-door-<版本>.tgz"
```

然后在该 profile 的用户自定义层 `cordis.patch.yml` 里插入一行：

```yaml
- insert:
    - id: acp-door
      name: dsh-acp-door
      config:
        provider: <服务商>
        model: <模型>
        preset: standard
```

或者把本包名 `dsh-acp-door` 加进该 profile `package.json` 的
`dsh.profile.bundles` 数组（本包自带的 `cordis.patch.yml` 会自动生效）。

## 怎么卸

1. 删掉上面那条 `insert` 记录（或把 `dsh-acp-door` 从 `bundles` 里去掉）；
2. `dsh plugin --profile <profile> remove dsh-acp-door`。

## 已知限制

- **没有鉴权**：本机上的任何程序都能连上这个端口。当前阶段靠「只监听回环」兜底，
  正式版会加一个口令文件。
- **硬依赖 `agentPresets`**：没有预设机制的 profile（例如纯 base 的 `acp` profile）
  不会启动这扇门。这是刻意的 —— 见上文第 1 个坑。
- 需要 DSH 重启后才会加载（profile 的 `patchReload` 为 `live` 时，配置改动可以热生效，
  但**新装一个包**仍需重启）。
- 依赖三个内部接缝：`@deepseek-ai/dsh-acp` 的 `config.stream`、
  `agentPresets.select()` 的签名、以及 `agent/created` 事件。
  它们在 DSH 升级中若变动，本插件需要跟着调整。
- 只能挂预设，**不能中途换**：内核只允许「还没产出任何内容」的会话切换预设。
