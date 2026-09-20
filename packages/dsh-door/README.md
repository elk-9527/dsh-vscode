# dsh-acp-door

在**正在运行的** DeepSeek Harness 内核上额外提供 **ACP 接入点**（只监听 `127.0.0.1`），
使外部程序（VS Code 面板）能够驱动**同一个** DSH —— 同一套配置、同一份记忆、
同一套工具、同一份会话记录。

![VS Code 面板通过 ACP 接入点插件连接同一个 DSH](assets/panel-chat.png)

| 权限模式（ACP 接入点插件对外暴露内核的权限预设） |
| --- |
| ![权限选择器](assets/panel-permission.png) |

<details>
<summary>English</summary>

**dsh-acp-door** opens an extra ACP (Agent Client Protocol) transport on a
**running** DeepSeek Harness kernel — loopback only (`127.0.0.1`), no
authentication, so it is meant for your own machine. External clients such as
the *DSH Panel* VS Code extension can then drive the very same kernel you
already have open: same config, same memory, same tools, same session records.

ACP normally speaks over stdio, which can only be attached at process start;
this plugin instead mounts one ACP bridge per TCP connection on top of the live
kernel, and exposes a few bypass methods the core does not have over ACP
(session listing, permission presets).

Install:

```sh
dsh plugin --profile <your-profile> add dsh-acp-door
```

Restart the kernel (or the desktop app) afterwards — plugins are loaded at
startup.

</details>

## 安装

```sh
dsh plugin --profile <档名> add dsh-acp-door
```

安装完成后需要**重启内核**（或重启桌面端）才会生效：ACP 接入点插件（`dsh-acp-door`）在内核启动时加载。
该插件装入哪个档，外部程序即可连接该档的 DSH —— 桌面端所用的档由桌面端自身管理
（运行时命令行无法修改），因此通常装入用户自己的档。

配置项（写入档的 `cordis.patch.yml`，见本包自带的同名文件）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 固定监听地址。其它值会被忽略，接入点不会暴露到局域网。 |
| `port` | `47821` | 监听端口。也可用环境变量 `DSH_ACP_DOOR_PORT` 覆盖（0.0.11 起）。 |
| `provider` / `model` | 见文件 | 新会话的初始模型；客户端连接后可针对会话修改。 |
| `preset` | `standard` | 新会话挂载的 agent preset 套件。 |

## 解决的问题

ACP 默认使用标准输入输出：该通道只能在进程**启动时**接入。
而 DSH Desktop 已处于运行状态时，外部程序无法接入该通道。

DSH 自带的 ACP 插件支持**注入传输层**（其源码中有对应实现）：

```js
const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
```

因此该插件仅执行一项操作：**在每个 TCP 连接上挂载一份 ACP 桥**。

```
DSH Desktop（运行中）
├── 内核：agents / llm / sessions / 工具 / 记忆 / 技能      ← 只有一份
├── 网页界面                                     （原有）
└── 该插件：127.0.0.1:47821  ── 每个连接 = 一份 ACP 桥      （新增）
```

## 会话预设补挂的必要性

这是该插件除监听端口之外**唯一**执行的实际操作，也是最易出错的环节，因此单独说明。

桌面端与网页端架构停用了**宿主层**的全部工具 —— `dsh-web-app` 的补丁中：

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
**lets each session mount a preset instead**"* —— 即工具改为
**每个会话按 agent preset 挂载一套**。

而 `@deepseek-ai/dsh-acp` 创建 agent 时只传入工作目录、**从不指定预设**
（`dsh-acp/lib/index.js` 的 `AcpSession.create` 中为 `meta: { cwd }`）。
两者结合后，经 ACP 建立的会话缺少工具来源：**宿主层未提供工具，预设层也未指定预设** ——
即一个无法调用工具的 agent（该 agent 会声明「我来读一下这个文件」，随后无法执行任何操作）。

内核自身的报错文案指明正确做法：

> `(join through AgentPresets.mount() or composeFrom() in the agent factory setup)`

因此该插件监听 `agent/created`，使用公开的 `agentPresets` 补上这一步。**新建会话**与
**恢复的会话**使用两个不同的入口 —— 该结论来自实测，并非推测：

| 情况 | 所用入口 | 原因 |
|---|---|---|
| 新建的会话 | `select(agent, id)` | 该入口重新组装 agent 的作用域，并将本次选择**追加进会话事件日志**（`agent-preset/selected`）。 |
| 恢复的会话（断线重连 / 打开历史会话） | `mount(agent.ctx, id)` | 内核按「是否执行过回合」为 `select` 设置了锁（`agent-preset/locked`，属设计行为）。恢复时 agent 的作用域为**重新组装**的结果，缺少该调用时作用域为空。`mount` 是工厂期使用的入口，只负责组装，不检查该锁。 |

### 恢复会话的缺陷记录

症状：面板断线重连（或重启内核后接回旧会话）之后，会话**一个工具都没有** ——
模型会声明"我来跑一下"，随后把工具调用当作文本写出（`<｜｜DSML｜｜invoke …>`）。
实测数据：同一个会话，断线前 18 次工具调用，接回后 **0 次**，正文退化为未转义的 DSML。

原因：`select()` 只在**新建**时能够挂载；恢复时该入口被锁定，而预设又**不会**从会话记录中
自动还原（见下文「会话记录中不含预设」）。因此恢复出的 agent 作用域为空。

修法：`select` 遇到预设锁时改用 `mount(agent.ctx, id)`。修复后同一试验立即变为接回后 10 次
工具调用（`packages/vscode-extension/test/presets.js` 第 8 节固定了这一结论）。

### 两项必须注意的约束（均已实测）

1. **`agentPresets` 必须写成声明式依赖。** cordis 的服务代理对未声明的属性
   **直接抛错**（`cannot get property "…" without inject`）。该异常发生在内核
   创建 agent 的**同步**流程中：或打断 `session/new`，或被 async 捕获，
   使该插件**静默失败**。因此该服务写入 `inject`，缺少该服务的 profile 不会启动这个插件。
   同一结论也适用于 `mount()`：该入口需要 **agent 的作用域上下文**（`agent.ctx`），
   传入错误对象会抛 `refusing to compose an unscoped context`。

2. **存在一处竞态，必须由入站闸阻塞。** 内核派发 `agent/created` 时**不等待**
   监听器返回的 promise，因此「补挂预设」与「客户端发送第一个 prompt」并行执行。
   实测数据（诊断日志原文）：

   | 时刻 | 事件 |
   |---|---|
   | `37.169` | `agent/created` 触发 |
   | `37.224` | 客户端 prompt 到达（**+55ms**） |
   | `37.526` | 预设挂载完成（耗时 **357ms**） |

   客户端请求先到达，因此模型收到 **0 个工具 schema**（会话记录中 `toolsTokens: 0`），
   只能把工具调用当作文本写出。因此 {@link gatePrompts} 在传输层阻塞该会话的
   `session/prompt`，直到挂载完成 —— 上表所示一轮实际阻塞 303ms。

### 会话记录中不含预设（结论已修正）

上文「记进会话记录」的表述曾出现在此处，**该表述有误**。实测（解开
`$DSH_HOME/sessions/<项目>/<会话>/session.v3.jsonl.zstd`）：

- 桌面端建立的会话，第一行 header 中含 `"agentPreset":"standard"`；
- 经该插件建立的会话，**不含** `agentPreset` —— 建立后读取即不存在，执行完一个回合后再读仍不存在。

即内核仅在桌面端所使用的建会话方式下将预设写入记录。因此：

1. 该插件无法从记录中获知原先挂载的预设 → 该插件在**内核进程内**保存一份
   `sessionId → preset` 映射（跨连接共享），客户端也会在 `session/resume` 的
   `_meta` 中指定所需预设，两个来源合并使用。
2. 这也是上文缺陷的根源：不读取记录则无法自动还原，必须依靠 `mount` 补挂。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 固定监听地址。其它值会被忽略，接入点不会暴露到局域网。 |
| `port` | `47821` | 监听端口；传 `0` 由系统分配空闲端口。 |
| `provider` | — | 新会话的初始模型服务商。**必须填写**，见下文警告。 |
| `model` | — | 新会话的初始模型名。**必须填写。** |
| `preset` | `standard` | 新会话挂载的 agent preset：`standard`（标准）/ `ptc` / `cordis`（创造）/ `minimal`（极简）。 |
| `diagLog` | 关 | 诊断日志文件路径；也可用环境变量 `DSH_ACP_DOOR_DIAG`。用于排查时序问题，未配置时不写任何文件。 |

### 警告：缺少 `provider` / `model` 时静默失败

缺少这两项时，**会话仍可建立，接入点仍正常监听**，但第一个回合直接失败：

```
agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model
```

该问题易于触发，因为按 id 定向的 `--patch` 覆盖是**整体替换**这份配置（并非合并）——
仅修改 `port` 而未写全其它键，会同时覆盖 `provider`/`model`。因此该插件在启动时
检查这两项，缺失时在内核日志中记录一次警告，无需等待用户发送消息才发现。
（`packages/vscode-extension/test/presets.js` 也校验 `cordis.patch.yml` 中必须包含这两项。）

## 版本变更

| 版本 | 改了什么 |
| --- | --- |
| 0.0.12 | 新增 `dsh-door/permission/get` 与 `dsh-door/permission/set` 两个旁路方法：将内核 `@deepseek-ai/dsh-permission-presets` 的权限预设**清单与切换**透传给客户端（ACP 仅暴露模型与推理强度两个 config option，权限选择器属于其「刻意不提供」的 DSH 专用 UI 类别）。清单**不写死** —— 内核配置了什么就返回什么（`read-only`/`workspace-write`/`danger-full-access` 来自 `dsh-base`，`auto-approval` 由 `dsh-auto-approval-plugin` 添加，用户也可自行添加），因此客户端一侧与桌面端始终为同一真源。`permissionPresets` 是**可选**依赖（`ctx.inject`），档中未挂载该服务时该插件照常工作、仅返回「这个内核没有权限预设」。回归测试：`test/permission.js`（纯函数 29 项）+ 扩展一侧的 `test/permission-live.js`（真内核，四档全切一遍 24 项）。 |
| 0.0.9 | **修复两个缺陷**：① 建会话**失败**时的预设指定会留在队列中，被**下一次**建会话取走（用户未指定却挂载了其它模式）—— 出错的回复原先未被处理（预筛要求该行含 `"result"`）；② 入站闸等待预设挂载**没有超时**，内核某个服务返回永不落定的 promise 时，`session/prompt` 会被永久阻塞 —— 症状为「发送消息后毫无响应、也没有任何报错」。现在入站与出站使用同一上限（`MOUNT_WAIT_MS`，经 `waitForMount()`），到时放行。<br>回归测试：`test/frames.js` 第 8 节第 (6) 段、第 9 节。 |
| 0.0.8 | 新增 `dsh-door/sessions/list` 与 `dsh-door/sessions/get` 两个旁路方法（该插件只读解析 `$DSH_HOME/sessions`，多帧 zstd）。供「内核没有 `session/load`、面板又需查看历史」的场景使用。另修复出站中继必须返回 `WritableStream`（写成 `TransformStream` 且无人消费 readable 时，该插件的回复始终无法发出，客户端表现为「已连接但不应答」）。 |
| 0.0.7 | 模式（agent preset）切换；修复「断线重连之后会话没有工具」（遇到预设锁时改用工厂期的 `mount()` 补挂）。 |
| 0.0.5 | 首个可用版本。 |

**注意**：该插件装入 `desktop` 档之后**不一定能够升级** —— 桌面端运行时
`dsh plugin --profile desktop …` 会被拒绝（`profile "desktop" is managed exclusively
by the Electron application`），需等待桌面端未运行。因此**面板不依赖该插件的版本**：
连接本机时面板自行读取 `$DSH_HOME/sessions`（`packages/vscode-extension/src/dsh/sessions.js`，
与 `lib/sessions.js` 之间有一致性测试约束）。

## 旁路方法：ACP 未提供的能力

该插件除转发 ACP 之外，还自行应答少量带 `dsh-door/…` 前缀的请求帧（**不转发给内核**，
就地回复），因为 ACP 协议中不包含对应能力：

| 方法 | 该插件所需的 params | 该插件的回复 | 起始版本 |
| --- | --- | --- | --- |
| `dsh-door/sessions/list` | `{}`（可选 `cwd`） | `{ skipped, sessions: [...] }` | 0.0.8 |
| `dsh-door/sessions/get` | `{ id, limit? }` | `{ card, entries, truncated }` | 0.0.8 |
| `dsh-door/permission/get` | `{ id }` | `{ currentValue, options: [{value, name?, description?}], defaultPreset? }` | 0.0.12 |
| `dsh-door/permission/set` | `{ id, value }` | 同 `permission/get`（**修改之后回读**的真实状态） | 0.0.12 |

权限相关的两个方法无法经由 ACP 提供：`@deepseek-ai/dsh-acp` 仅将**模型**与**推理强度**
暴露为 `session/set_config_option`，其 README 写明该实现「刻意不提供 DSH 专用呈现数据
与交互式 UI 功能」。权限选择器正属于该类别。

实现上需注意两点：

1. `permissionPresets` 是**可选**依赖 —— 使用 `ctx.inject(['permissionPresets'], …)`
   而不写入 `export const inject`。若写死，未挂载该服务的档（例如极简的自建档）
   会**导致整个插件无法加载**，而非仅权限这一项不可用。
2. 切换后**回读**再回复（`settledPermission`），不采用乐观更新：若某项设置被其它
   机制阻塞，客户端显示的是真实状态。

## 从源码目录或 tgz 安装

在目标 profile 中安装该包，两种来源均可，但需明确两者的区别：

```powershell
# A) 指向源码目录：开发用，安装后即可使用（pnpm 会将其复制进 profile）
dsh plugin --profile <profile> add "file:<本目录>"

# B) 使用 npm pack 的 tgz：接近用户实际获取的产物
cd <本目录>; npm pack
dsh plugin --profile <profile> add "file:<本目录>\dsh-acp-door-<版本>.tgz"
```

**不应使用 `link:`。** 该方式会建立真实符号链接，Node 解析依赖时按**真实路径**向上查找，
因此 `import '@deepseek-ai/dsh-acp'` 无法解析（该包不在源码树中，而在 profile/DSH 安装目录中），
导致该插件无法启动。更严重的是，删除该链接时 pnpm 可能**同时清空源码目录** ——
该情况已实际发生一次，依靠 profile 中的那份副本才得以恢复。

**修改源码后必须重新执行一次 `add`。** `file:` 是**拷贝**而非链接，且 pnpm 存在缓存，
源码变更后有时直接报告 `added 0`（内容未替换）。`packages/vscode-extension/test/helpers/door.js`
的 `syncDoor()` 在每次运行测试前逐字节比对源码与已安装的那份，不一致时自动重装 ——
避免测试实际验证旧代码。

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

或者将该包名 `dsh-acp-door` 加入该 profile `package.json` 的
`dsh.profile.bundles` 数组（本包自带的 `cordis.patch.yml` 会自动生效）。

## 卸载

1. 删除上述 `insert` 记录（或将 `dsh-acp-door` 从 `bundles` 中移除）；
2. `dsh plugin --profile <profile> remove dsh-acp-door`。

## 已知限制

- **没有鉴权**：本机上的任何程序均可连接该端口。这是本机使用的明确边界：该插件固定
  监听 `127.0.0.1`，不支持通过改地址、端口转发或隧道把接入点提供给其它设备。
- **硬依赖 `agentPresets`**：不提供预设机制的 profile（例如纯 base 的 `acp` profile）
  不会加载该插件。该限制属刻意设计 —— 见上文第 1 项约束。
- 需重启 DSH 后才会加载（profile 的 `patchReload` 为 `live` 时，配置改动可以热生效，
  但**新装一个包**仍需重启）。
- 依赖三个内部接缝：`@deepseek-ai/dsh-acp` 的 `config.stream`、
  `agentPresets.select()` 的签名、以及 `agent/created` 事件。
  它们在 DSH 升级中若变动，该插件需要同步调整。
- 仅能挂载预设，**不能中途切换**：内核只允许「尚未产出任何内容」的会话切换预设。
