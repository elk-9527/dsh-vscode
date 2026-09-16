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

所以本插件监听 `agent/created`，用公开的 `agentPresets` 补上这一步。**新会话**和
**恢复的会话**走的是两个不同的入口 —— 这是踩出来的，不是猜的：

| 情况 | 用哪个 | 为什么 |
|---|---|---|
| 新建的会话 | `select(agent, id)` | 它会重组装 agent 的作用域，并把这次选择**追加进会话事件日志**（`agent-preset/selected`）。 |
| 恢复的会话（断线接回 / 打开历史会话） | `mount(agent.ctx, id)` | 内核按「有没有跑过回合」给 `select` 上了锁（`agent-preset/locked`，这是设计）。而恢复时 agent 的作用域是**重新组装**的，不补这一刀它就是个空壳。`mount` 是工厂期用的入口，只负责组装，不看那把锁。 |

### 恢复会话这里真出过一个 bug，记下来

症状：面板断线重连（或重启内核后接回旧会话）之后，会话**一个工具都没有** ——
模型会说"我来跑一下"，然后把工具调用当文本写出来（`<｜｜DSML｜｜invoke …>`）。
实测数据：同一个会话，断线前 18 次工具调用，接回来 **0 次**，正文变成裸的 DSML。

为什么：`select()` 只在**新建**时能挂上；恢复时它被锁，而预设又**不会**从会话记录里
自动还原（见下面那条"记录里其实没有预设"）。于是恢复出来的 agent 手里空空。

修法：`select` 撞锁就改用 `mount(agent.ctx, id)`。修完同一个试验立刻变成接回后 10 次
工具调用（`test/presets.js` 第 8 节把这条钉住了）。

### 两个必须注意的坑（都实测踩过）

1. **`agentPresets` 必须写成声明式依赖。** cordis 的服务代理对未声明的属性
   **直接抛**（`cannot get property "…" without inject`）。而这个异常发生在内核
   创建 agent 的**同步**流程里：要么打断 `session/new`，要么被 async 吞掉、
   让门**假装在工作**。所以它进了 `inject`，缺这个服务的 profile 会直接不启动这扇门。
   同一条也适用于 `mount()`：它要的是 **agent 的作用域上下文**（`agent.ctx`），
   传错东西会抛 `refusing to compose an unscoped context`。

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

### 记录里其实没有预设（这条纠正过）

上面那句"记进会话记录"曾经写在这里，**是错的**。实测（解开
`$DSH_HOME/sessions/<项目>/<会话>/session.v3.jsonl.zstd`）：

- 桌面端建的会话，第一行 header 里有 `"agentPreset":"standard"`；
- 走本门建的会话，**没有** `agentPreset` —— 建完就读没有，跑完一个回合再读还是没有。

也就是说，内核只在"桌面端那种建会话方式"下才把预设写进记录。所以：

1. 门不能指望从记录里知道自己原来挂的是哪个预设 → 门在**内核进程内**记一份
   `sessionId → preset`（跨连接共享），客户端也会在 `session/resume` 的
   `_meta` 里点名它要的预设，两个来源合并着用。
2. 这也正是上面那个 bug 的根：不看记录就没法自动还原，必须靠 `mount` 补挂。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。**不要改成 `0.0.0.0`**，那会把门开到局域网上。 |
| `port` | `47821` | 监听端口；传 `0` 让系统挑空闲端口。 |
| `provider` | — | 新会话的初始模型服务商。**必须写**，见下面的警告。 |
| `model` | — | 新会话的初始模型名。**必须写。** |
| `preset` | `standard` | 新会话挂载的 agent preset：`standard`（标准）/ `ptc` / `cordis`（创造）/ `minimal`（极简）。 |
| `diagLog` | 关 | 诊断日志文件路径；也可用环境变量 `DSH_ACP_DOOR_DIAG`。排查时序问题用，不配则完全不写文件。 |

### 警告：`provider` / `model` 缺了会静默变哑

少了这两项，**会话照样建得起来、门照样开得好好的**，但第一个回合直接失败：

```
agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model
```

很容易踩，因为 id 定向的 `--patch` 覆盖是**整体替换**这份配置（不是合并）——
只想改 `port` 而没写全其它键，就把 `provider`/`model` 一起冲掉了。所以门在启动时
会检查这两项，缺了就在内核日志里吵一次，不等用户发了消息才发现。
（`test/presets.js` 也盯着 `cordis.patch.yml` 里必须有这两项。）

## 怎么装

在目标 profile 里装这个包，两种来源都行，但要知道它们的区别：

```powershell
# A) 指向源码目录：开发用，装完就能用（pnpm 会把它拷进 profile）
dsh plugin --profile <profile> add "file:<本目录>"

# B) 用 npm pack 的 tgz：最接近"用户拿到的东西"，也最稳
cd <本目录>; npm pack
dsh plugin --profile <profile> add "file:<本目录>\dsh-acp-door-<版本>.tgz"
```

**别用 `link:`。** 那会建一个真符号链接，Node 解析依赖时按**真实路径**往上找，
于是 `import '@deepseek-ai/dsh-acp'` 找不到（它不在源码树里，而在 profile/DSH 安装目录里），
门直接起不来。更糟的是，删掉这个链接时 pnpm 可能**把源码目录一起清空** ——
真发生过一次，靠 profile 里的那份拷贝才救回来。

**改了源码必须重新 `add` 一次。** `file:` 是**拷贝**而不是链接，而且 pnpm 有缓存，
源码变了它有时直接报 `added 0`（内容没换）。`test/helpers/door.js` 的 `syncDoor()`
每次跑测试前会逐字节比对源码与装的那份，不一致就自动重装 —— 免得测试悄悄测了旧代码。

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
