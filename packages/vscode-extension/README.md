# DSH Panel

在 VS Code 的侧边栏里直接用 DeepSeek Harness。

**不用先在桌面上打开 DSH**：点开侧边栏就能提问。内核由扩展自己按需启动，
而记忆、会话记录、插件都来自你的 `$DSH_HOME` —— 和桌面端是同一份。
桌面端开着的时候，面板会直接连它（一个进程、一个大脑），不会再起第二个。

它不是另一个 agent，也不会另起一套记忆：同一份配置、同一份记忆、
同一份会话记录、同一套工具与权限策略。

![面板](media/screenshots/panel-chat.png)

| 权限模式（会话中途也能换） | 历史会话（点一条就接回上下文） |
| --- | --- |
| ![权限](media/screenshots/panel-permission.png) | ![历史](media/screenshots/panel-history.png) |

<details>
<summary>English</summary>

**DSH Panel** puts [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) in the
VS Code sidebar. You do not have to start the desktop app first — the extension
starts a DSH kernel on demand, or attaches to the one already running.

It is not another agent and it does not keep a second memory: same `$DSH_HOME`,
same sessions, same plugins, same tools and permission policy as the desktop app.
Model, agent preset and permission mode are read from the running kernel (not
hard-coded), and the permission mode can be switched mid-conversation.

To connect, DSH needs the companion plugin **`dsh-acp-door`**, which opens a
loopback-only ACP port inside the kernel (`dsh plugin --profile <profile> add
dsh-acp-door`). Only `127.0.0.1` is ever listened on; there is no authentication,
so it is meant for your own machine.

Requires VS Code 1.85+ and a local DSH install. UI text is Chinese today.

</details>

## 它是怎么接上去的

```
VS Code 侧边栏（本扩展）
        │  ACP（JSON-RPC，一行一个 JSON）
        ▼
   「门」插件 dsh-acp-door           ← 装在 DSH 内核里的一个小插件
        │  在本机回环端口 47821 上再挂一份 ACP 桥
        ▼
   DSH 内核                          ← 桌面端那个，或者扩展自己拉起的那个
```

- 门**只监听本机回环地址**，不接受外部连接。
- **端口上已经有门就复用**（桌面端开着时就是这种，不会多起进程）；
  **没有门就自己启动一个**，用的是 `dshPanel.fallbackProfile`
  （默认 `vscode-panel` —— 面板自己的档，从官方 web 模板建的，装了门和你那套插件）。
- **面板自己起的那个内核有自己的端口**（`dshPanel.selfStartPort`，默认 47831），
  不再去抢桌面端那个 47821：两个内核抢同一个端口没有任何好处，抢输的那个门
  干脆不开，你对着"正在启动…"干等。扩展启动内核时把这个端口写进环境变量
  `DSH_ACP_DOOR_PORT`，门优先读它（门 0.0.11+；旧版门不认，此时面板会两个
  端口都盯，照样接得上）。
- **关掉侧边栏 ≠ 收掉内核**（2026-09-19 改，见下）：折叠侧边栏、拖面板、
  `Reload Window` 都只让面板"松手"，内核继续活着；宽限期（`dshPanel.kernelIdleMinutes`，
  默认 10 分钟）内重新打开面板就接着用同一个进程。只有**关掉 VS Code 窗口**、
  宽限到期、或者你自己执行「DSH：停掉后台内核」才会真收掉。
  桌面端那个内核（47821）不管什么情况都绝不碰。
- 想让面板永远用自己的内核（不碰桌面端那个），把 `dshPanel.autoStart` 保持
  打开，并把 `dshPanel.port` 改成一个桌面端不用的端口即可。
- **自己启动失败时会换档再试**：设置里那个档排第一（尊重你的选择），起不来就
  在 `$DSH_HOME/profiles` 里找一个装了门、而且是网页档的接着试。内核自己
  报的错（退出码 + stderr）会被读出来照实转述，不再猜。

### 为什么"面板一关就杀内核"是错的（2026-09-19）

以前 `dispose()` 里直接 `killTree` 掉自己起的那个内核。而**面板比你以为的容易没**：
折叠侧边栏、把面板拖到另一个位置、`Reload Window`、另一个窗口关掉……每一次
都是一次"杀内核 + 重连"。用户看到的就是"聊两句突然断线"，而且是随机的。

现在内核的归属是这样分的：

| 谁 | 谁负责收 |
| --- | --- |
| 桌面端那个（47821） | 桌面端自己。扩展只连，绝不收 |
| 另一个 VS Code 窗口起的面板内核 | 那个窗口。本窗口只连 |
| **本窗口起的**面板内核 | 本扩展。最后一个使用者松手后进入宽限（默认 10 分钟），到期才收；窗口关闭时立刻收 |

验证这件事的测试：`test/kernel-manager.js`（假进程，26 项）+
`test/fallback.js` §6（真进程：销毁面板后内核还必须活着，重开面板必须复用
同一个 pid）。

### 长跑耐力测试（`tools/soak.cjs`）

"起得来但活不长"这类毛病，功能测试是抓不住的。这个工具就是连着干活：

```powershell
# 用生产那个档跑 10 分钟，每 40 秒一个真回合
node tools/soak.cjs --profile vscode-panel --minutes 10 --turn-every 40
# 换端口、顺便验证"门听环境变量"（档里配 47830，环境变量说 47831）
node tools/soak.cjs --profile vscode-panel --port 47831 --patch <档里配 47830 的 patch> --minutes 2
```

跑完会给出：成功/失败回合数、内核有没有自己退出、断线次数、内核临死前说的话。
（2026-09-19 用它跑过两轮各 10 分钟：生产档 10 回合 0 断线、最小档 10 回合
0 断线 —— 用户报的"35 秒就死"在我这儿复现不出来，见交接文档。）


### 门要装进哪个档（这里踩过一个大坑）

门插件装在哪个 profile 里，面板就连得上哪个 profile 的 DSH。

**坑（2026-09-19）**：一开始默认用 `desktop` 档 —— 想的是"和桌面端同一档，
记忆技能插件完全一致"。但那个档**被桌面端独占**，普通命令行起不来：

```
error: profile "desktop" is managed exclusively by the Electron application
```

于是"桌面端没开"的时候面板必然起不来，而那恰恰是最需要它自己起来的时候。
现在的做法：

- 面板有自己的档 **`vscode-panel`**（`dsh --profile vscode-panel
  --from-default-profile web` 建的，再 `dsh plugin --profile vscode-panel add
  <门插件>` 和你在用的那些插件），命令行能起、能开 TCP 门；
- PATH 上那个 `dsh` 是**桌面端自己的垫片**（`DSH Desktop.exe` 带
  `ELECTRON_RUN_AS_NODE` 跑 `desktop-cli.js`），它反而**能**跑 `desktop` 档 ——
  但它住在一个带哈希的一次性目录里，桌面端换代就换路径，所以一个开得早的
  VS Code 可能还指着已经删掉的那一代：`dsh` 找不到、`node bin.js` 又拒绝
  `desktop`，**两条路一起死**。这就是那个 bug 的完整成因。

**注意**：插件是在内核启动时加载的。装完之后，已经在跑的桌面端不会立刻有门 ——
要么重启一次桌面端（得到一个进程、一个大脑的最优状态），
要么就让扩展自己拉一个内核（同一份记忆，只是多一个进程）。

### 受限模式（Restricted Mode）也没问题

清单里声明了 `capabilities.untrustedWorkspaces.supported = true`。

这一条不是装饰：**不声明它的扩展，在 VS Code 的受限模式里会被整个禁掉** ——
表现是"面板凭空消失，还不报错"，非常难查（真在隔离窗口里踩到过：
同一个扩展，不带工作区文件夹能激活，带一个未被信任的文件夹就完全不加载）。
本扩展不执行工作区里的代码：读工作区文件只发生在你主动右键「带进对话」时，
设置也只读用户级设置（受限模式下 VS Code 本来就不套用工作区设置）。

## 安装

1. **装这个扩展**：市场里搜 `DSH Panel`，或者命令行
   `code --install-extension <publisher>.dsh-panel`。
2. **给 DSH 装上配套插件**（只需要一次）：

   ```sh
   dsh plugin --profile <你的档> add dsh-acp-door
   ```

   没装它也能用：面板会自己启动内核，但那个档里同样得有这个插件 —— 否则面板
   连不上任何 DSH，只会在对话流里说明「这套配置里没装连接组件」。
   装在哪个档，决定了面板能连上哪个档的 DSH（详见下面「门要装进哪个档」）。
3. 打开侧边栏，直接提问。

## 用法

1. 点侧边栏的 DSH 图标（活动栏里那个对话气泡）。
2. 直接提问。Enter 发送，Shift+Enter 换行。
3. 顶栏是模型下拉与上下文用量；右上角是「新建对话」与「重新连接」。
4. 连接中途断掉（比如 DSH 重启了）不用管：下次发送会自动重连，
   并**自动接回原来那个会话**（ACP 的 `session/resume` 实测保上下文）。
   万一接不回来（内核里已经没了），面板会明确告诉你「上面那段它不记得了」，
   而不是悄悄换成一段没有记忆的新对话。

### 把编辑器里的东西带进对话

两个命令（命令面板里搜 `DSH`，或者**在编辑器里右键**）：

| 命令 | 什么时候有 | 带过去的东西 |
| --- | --- | --- |
| `DSH：把选中的代码带进对话` | 编辑器里有选区时 | 选中的那几行**正文** + 这个文件的链接 |
| `DSH：把当前文件带进对话` | 打开着文件时 | 只给这个文件的链接，让 DSH 自己去读 |

带过去的东西会变成输入框上面的一小块，点 `×` 可以拿掉；发出去之后，
那条消息气泡里也留着当时带的清单。

为什么两者不一样：**选中的代码小、且你的意思往往就是"就这几行"，直接把正文给模型最准**；
**整个文件可能很大，只给一条链接（ACP 的 `resource_link`）让 DSH 用自己的工具去读** ——
不占上下文，读到的永远是最新版本。

### 权限与确认

工具调用要不要问你，取决于你那个 profile 的权限策略（桌面端装了 `auto-approval`，
默认不打断你）。面板能在内核真的来问的时候弹出选项，也会把代码改动渲染成 diff。

**顶栏还有一个「权限」按钮**（跟桌面端同一个东西）：点开就是内核里那份权限预设
清单 —— 桌面端有什么档，这里就有什么档：

| 档 | 意思 | 来源 |
| --- | --- | --- |
| 仅可查看 | 能读任何位置，但不改任何东西 | 内核自带 |
| 工作区内修改 | 工作区/临时目录里能写，越界先问你 | 内核自带 |
| Auto Approval | 工作区里能写，外加自动批准那些无害的命令 | `dsh-auto-approval-plugin`（你装了才有） |
| 完全权限 | 不问你了，什么都能做 | 内核自带 |

几个刻意的设计：

- **清单不写死在面板里**，是每次建会话时从内核读回来的（`dsh-door/permission/get`）。
  所以你（或者某个插件）往内核里加了档，面板上立刻就有，中文名乱码、少一项这种
  错位不会发生。清单里认不出来的档（比如插件加的）原样显示内核给的名字与说明。
- 内置那三档的说明文字是**翻译过的中文**（桌面端显示的是内核里的英文原文）——
  这是唯一一处刻意跟桌面端不一样的地方，为的是少让人读英文。
- **「完全权限」点了会先问一句**（跟桌面端一样）：它意味着不再逐条确认，
  点错的代价太大，所以确认门放在**客户端**而不是内核里。
- 切权限是**随时可切、当前这段就生效**的（跟「模式」不一样，模式换不了当前这段）。
  切完以**内核回读的**为准，失败会明说并回到真实状态。
- 连着的门太旧（0.0.12 以下，比如**桌面端那个档里的门**）时，按钮会变成
  灰色的「切不了」，悬浮提示 + 对话流里说清为什么、怎么升
  （顶栏那一格只有 4 个字的地方，理由塞不下 —— 见「给用户看的字都要短」）。
  这个时候你仍然可以在**桌面端自己的界面**上切 —— 那边不走门这条路。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dshPanel.host` | `127.0.0.1` | 「门」的监听地址 |
| `dshPanel.port` | `47821` | 「门」的端口，要和门插件里写的保持一致 |
| `dshPanel.autoStart` | `true` | 端口上没有门时，自己启动一个内核（开着就不用先开桌面端） |
| `dshPanel.fallbackProfile` | `vscode-panel` | 自己启动内核时用哪个 profile（里面要装好门插件）。**别填 `desktop`** —— 那个档被桌面端独占，命令行起不来 |
| `dshPanel.dshCommand` | `dsh` | `dsh` 命令的名字或完整路径 |
| `dshPanel.provider` / `dshPanel.model` | 空 | 新会话的初始模型，留空由内核决定 |
| `dshPanel.cwd` | 空 | 新会话的工作目录，留空用当前工作区 |

## 命令

- `DSH：新建对话` —— 关掉当前会话，开一个新的。
- `DSH：重新连接` —— 断开重连（改了端口或刚启动 DSH 后用）。
- `DSH：查看日志` —— 打开输出面板里的 DSH Panel 通道，出问题时看这里。

## 现在的边界（说清楚，免得你以为是坏的）

- **只连本机**，没有鉴权。所以它只适合自己电脑上用。
- 面板里的**预设（preset）**跟随门的配置，不能在会话中间切换 ——
  内核的 `agentPresets` 在首个回合之后会锁住（`agent-preset/locked`），
  而且 ACP 没把预设暴露成可选配置项。
- **权限模式**：ACP 同样没暴露（它只认模型/推理强度两个 config option），
  所以这一项是连接组件替内核接出来的旁路方法，**要 dsh-acp-door 0.0.12 以上**。
  连的那台太旧、换不了权限时，面板会**自动改用自己启动的那台**（那台的组件
  是跟本扩展配套的新版）—— 所以「接着桌面端那个内核」不会让你丢掉权限选择器；
  代价是那一刻会多一个内核进程。真换不了（比如那台 DSH 压根没带权限设置）时，
  按钮灰掉写「切不了」，原因用一句人话说明（不出现「门」「包名」「版本号」）。
- **不许在面板里说内部词**（用户 2026-09-20 的原话：「『门』都出来了，别人能
  知道是什么意思？类似的提示全删了」）。所以界面文案里不许出现：连接组件名
  （「门」）、包名（`dsh-acp-door` / `dsh-base` / `@deepseek-ai/*`）、版本号
  （`0.0.12`）、「档」（profile）、设置项全名、「内核原话」这种我们自己才用的说法。
  **内核自己吐的原文不在此列** —— 它收在「原始报错（点开）」折叠区和日志里，
  一个字都不删，那是证据不是讲解。这条规矩有三个测试盯着
  （`test/permission.js` §6 黑名单、`test/panel.js` §8.7 与 §8.9 扫真发出去的消息、
  `tools/uitest.js` 扫渲染出来的悬浮提示）。
- **历史会话列表**能列出本机 `$DSH_HOME/sessions` 里的会话（标题、时间、回合数、
  工作目录），点一条就能接回上下文 —— 连的是本机时面板自己读盘，不用门支持什么
  新方法。连**别的机器**上的门时，只能靠门提供 `dsh-door/sessions/*`（0.0.8+），
  门太旧就只回一句「去升级那台机器上的门」。
- 顶栏那一行**只放短状态**（就绪 / 工作中 / 未连接）。报错原文与诊断都进对话流，
  长原文收在「原始报错（点开）」的折叠里 —— 一个字都不删，但不占地方。
- **给用户看的字都要短**（用户提过两次意见，2026-09-19 定的规矩）：

  | 位置 | 上限 | 例子 |
  | --- | --- | --- |
  | 顶栏状态 | ≤ 24 字、不许换行 | `正在启动…`、`就绪` |
  | 对话流提示第一行 | ≤ 32 字 | `正在启动 DSH…`、`接着用已经开着的 DSH。` |
  | 提示里引用的内核原话 | 另起一行、≤ 80 字 | `原因：…` |
  | 报错的标题 / 怎么办 | ≤ 32 / ≤ 48 字 | `额度或频率到上限了，这一回合没跑完。` |

  用哪个档、哪个命令、哪个端口这类**排障细节**一律只进日志（`DSH：查看日志`）
  或折叠区；面板里不再出现「没有现成的内核，正在启动一个（档：vscode-panel）。
  第一次会慢一点，之后就快了。」这种长句。这条规矩有两个测试盯着
  （`test/panel.js` §8.9 扫一遍这次跑下来**真发出去过的所有消息**、
  `test/fallback.js` 盯自启那条路），加长文案会直接红。
- **两个内核的情形**（`autoStart` 打开时）：面板先连 `dshPanel.port`（47821）上
  现成的那台 —— 桌面端开着时那就是桌面端的内核；如果它换不了权限，面板会改用
  自己启动的那台（在 `selfStartPort` 上）。所以在「桌面端 + VS Code 面板」同时
  开着、而桌面档里的连接组件还是旧版时，机器上会有两个内核：一个桌面端的、
  一个面板自己的。想只要一个，就把桌面那个档里的连接组件也升上来
  （那个档归桌面端管，升级后要重启桌面端）。
- **顶栏配置行的宽度怎么分**（同一天定的，用户第二次反馈「模型的占地有点大，
  其他两点有点小」）：三个格子按 7:6:6 分，各自有**下限**（模型 116 / 模式 96 /
  权限 108），用量条排在最后、**装不下就自己换行**（宁可顶栏多一行小条，
  也不把字挤没）；面板窄到 360px 以下时把「模型 / 模式 / 权限」三个标签收起来，
  省下的宽度全给控件。这几条在 `tools/uitest.js` 的 access 场景里有断言盯着
  （各 ≥100px、模型不超过模式那格的 1.4 倍、按钮不截字、配置行不横向溢出）。
- 图片粘贴不支持（内核实测 `promptCapabilities.image = false`）。

## 出问题怎么办

1. 先跑 `DSH：查看日志`，看有没有「连不上」「握手失败」。
2. 手动确认门在不在：`Test-NetConnection 127.0.0.1 -Port 47821`。
3. 确认门插件装好了：`dsh plugin --profile <你的 profile> list`。
4. **对话流里说「内核自己退出了（code=…）」** → 面板自己拉的那个内核死了。
   下面多半紧跟着内核最后说的话（它自己的原文）。想看全文：

   ```powershell
   node tools/panel-log.cjs --grep 内核
   ```

   内核一个字没说就退了，通常意味着**是外面把它杀了**（不是它自己崩的）——
   比如有人手工 `taskkill`、系统清理工具、或者你的杀软。
5. **对话流里说「刚才连的是别处正在跑的 DSH（多半是你桌面端那个）」** →
   断线来自桌面端那边的内核退出/重启，不是面板的问题。直接发消息，
   面板会自己拉起一个内核并把上下文接回来。

## 开发

扩展是**纯 JavaScript、零运行时依赖、无构建步骤** —— 改完文件直接重载窗口即可。

一条命令跑完全部测试（内核没开的话，测试会自己按需拉起、跑完自己收）：

```powershell
node test/run-all.js        # 快速套件：静态契约 + 拼块单测 + Markdown 单测 + 面板层，约 15s
node test/run-all.js --ui   # 再加上真浏览器里的界面断言（需要 Chrome）
node test/run-all.js --all  # 再加上真进程的自启内核、断线接回、模式、权限预设、端到端，约 4 分钟

# 真 VS Code 隔离窗口里的端到端自检（不碰你自己那个窗口）。**发版前请带上 --linger**：
$env:DSH_PANEL_CHECK_PORT = '47830'
$env:DSH_PANEL_CHECK_PROFILE = 'vscode-panel'
$env:DSH_PANEL_CHECK_DSH = 'node C:\Users\Lenovo\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --patch %TEMP%\dsh-panel-test-door-47830.yml'
$env:DSH_PANEL_CHECK_LINGER = '90'      # 建出会话之后再多盯 90 秒
node tools/vscode-check.js

# 面板自己那份日志（「输出 → DSH Panel」）翻出来看 —— 内核的原话就在里面
node tools/panel-log.cjs                # 最新一条，最后 60 行
node tools/panel-log.cjs --grep 内核     # 只看内核相关的行
node tools/panel-log.cjs --list         # 列出每个窗口的面板日志
```

**为什么要 `--linger`**：2026-09-19 用户报「聊两句就 `read ECONNRESET`」，
查日志发现**每个自启的内核都在起来约 35 秒后退出 code=1**。
而这个自检以前只观察到「会话建出来了」（约 15 秒）就收摊 ——
也就是说，「内核起得来、但活不长」这种毛病，原来的自检**根本看不见**。
现在它会多盯 90 秒，并断言这期间内核一直在、连接一次都没断。
绿灯只代表"到那一刻为止没问题"，不代表"接下来一分钟也没问题"。

单独跑某个套件：

```powershell
node test/static.js      # 静态契约：HTML id ↔ 取元素、消息协议双向、CSS 类、零硬编码颜色
                         #   以及「扩展默认端口/主机 = 门实际监听端口/主机」这类跨文件约定
node test/sessions-parity.js  # 两份「历史会话读取」实现（门的 ESM + 面板的 CJS）必须逐项一致
node test/spawn-quote.js # 带空格的命令路径（真进程）：造一个带空格的 .cmd 垫片实际跑一遍
node test/markdown.js    # Markdown 渲染器：语法、注入安全、病态输入不死循环、真实耗时
node test/blocks.js      # 编辑器上下文拼块：选区正文、resource_link、围栏加长、脏数据
node test/session.js     # 会话层边界（假客户端）：切模型信内核回复、用量帧只给一半、帧的归属与合并
node test/panel.js       # 面板层集成：注入假 vscode，连真的门
node test/fallback.js    # 自启内核：端口空着时能否从零拉起来、跑一个真回合、收摊能否杀干净
                         #   默认用 47821；那个端口被占（桌面端开着）时，换个空端口跑：
                         #   $env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js
node test/resume.js      # 断线后 session/resume 到底能不能把上下文接回来（带对照组）
node test/presets.js     # 模式（agent preset）：新会话挂上、恢复会话补挂、工具没丢
node test/permission-live.js  # 权限预设（连接组件 0.0.12+）：自己起内核，四档全切一遍，
                         #   两段会话互不影响、错名字/错会话都要明确报错
                         #   另有一套纯函数断言盯着「接上的那台换不了权限时要不要换一台」
                         #   （test/panel.js §8.86；真窗口那条路见 tools/vscode-check.js）
node test/smoke.js       # 端到端：协议、真回合、工具调用、中断、切模型、多轮、
                         #   以及编辑器上下文（选中代码里的暗号 + 带进来的文件里的暗号）
node tools/uitest.js     # 无头 Chrome 里对界面做 400+ 项断言（10 个场景，含通用视觉体检：
                         # 文字截断 / 按钮太小 / 浮层跑出面板 / 消息间距不一致）
                         #   其中 access 场景真的点开权限选择器：四档都在、当前那档打勾、
                         #   完全权限要先过确认门、Esc/点外面能关、切不了时按钮灰掉
node tools/uitest.js access  # 只跑「权限选择器」那个场景
node tools/uitest.js context  # 只跑「带编辑器上下文」那个场景
node tools/shots.js      # 把每个场景 × 深/浅主题拍成图（shots/*.png），
                         # 用于"用眼睛看"和改动前后对比。加场景名可只拍一个。
node tools/design-audit.js  # 界面尺度审计：字号/间距/行高/圆角各有几种、有没有硬编码颜色。
                         # 美化那一步用它量"改前改后"；加 --strict 时有硬编码颜色就非 0 退出。
node tools/build-vsix.js # 打包成 vsix（本地安装用；要打进包里的文件清单在 tools/ship-list.js，
                         # 只有那一份 —— 市场那边用 vsce + .vscodeignore，两个清单必须一致）
node tools/make-icon.cjs # 生成市场用的 media/icon.png（128×128）。活动栏那个 svg 是单色
                         # + currentColor，直接拿去当市场图标等于看不见，所以要从它转一张彩色的。
node tools/publish.js    # 市场发布：不加参数是彩排（自检 + vsce 打包 + 与上面那份清单逐文件比对），
                         # 加 --yes 才真发（需要 VSCE_PAT；占位符没填会被拒绝）

# 下面四个是「排查用」的，不是测试套件的一部分，也不打进 vsix（只 ship ship-list.js 里那几样）。
# 它们跑的是你这台机器的真实环境，所以只适合手动跑：
node tools/check-installed.cjs     # 装进 VS Code 的那份和仓库源码是否逐字节一致
                                   # （判断"用户跑的是不是当前源码"—— 出过一次"改了源码但没装"）
node tools/check-local-history.cjs # 面板"自己读盘"这条路在真机上看到了什么：
                                   # 磁盘几段、读到几段、有没有解码失败、耗时、列表上限截掉多少
node tools/who-owns-door.cjs       # 47821 上那个门是谁开的（桌面端自己的内核？测试留下的孤儿？）
                                   # 门没开时会告诉你面板会自己启动一个内核
node tools/check-eol.cjs           # 有没有文件混着 CRLF 和 LF（逐字节比对最怕这个；混了就非 0 退出）
                                   # 从任何目录跑都一样，不依赖当前工作目录
# tools/vscode-check.js 是真窗口自检，用法见文件开头：
#   自启模式（跑完 15 项）：   $env:DSH_PANEL_CHECK_PORT='47832'; node tools/vscode-check.js
#   接旧门→换内核（跑完 16 项）：$env:DSH_PANEL_CHECK_PORT='47821'
#                              $env:DSH_PANEL_CHECK_SELF_PORT='47832'
#                              $env:DSH_PANEL_CHECK_PROFILE='vscode-panel'
#                              node tools/vscode-check.js
#   （后者验的是「接上那台换不了权限 → 改用自己启动的那台 → 读完权限」这条链）

node tools/vscode-check.js  # **真 VS Code 窗口里**的自检：开一个隔离窗口（自己的 user-data-dir 和
                            # extensions-dir，不碰你正开着的窗口），用 DSH_PANEL_AUTOFOCUS=1 让它
                            # 自动展开面板，断言 15 条：窗口起来 / 扩展激活 / 六个命令注册 /
                            # 视图进活动栏 / 面板展开 / ACP 握手 / 建出会话 /
                            # 权限那一路有结果（读到清单，或者明确说清为什么切不了）/
                            # 内核这件事（端口上有门就是「接入模式：不许另起内核」，
                            # 没门就是「自启模式：必须自己拉起来」）/ 收摊干净 /
                            # 不留孤儿内核 / 你自己的窗口没被动。约 30 秒，跑完自动收摊。
                            # 加 --keep 可以留着窗口自己看。
                            # **一个内核都不杀**：只收自己开的那个隔离窗口，剩下的只报告 ——
                            # 靠名字/参数去 taskkill 是有可能误伤你自己正在用的内核的。
                            #
                            # 桌面端开着也想验「自启模式」（用户最常走的那条路），把这次自检
                            # 引到一个空端口上即可 —— 这三个环境变量只写进**隔离窗口自己的
                            # settings.json**，你的设置一个字都不动：
                            #   $env:DSH_PANEL_CHECK_PORT = '47830'
                            #   $env:DSH_PANEL_CHECK_PROFILE = 'dshdoor'
                            #   $env:DSH_PANEL_CHECK_DSH = 'node <bin.js> --patch <把门钉到 47830 的 patch>'
                            # 2026-09-19 实测：这两条路各 11 项全过（自启那次 11 秒建出会话）。
```

调试用的自检开关：设了环境变量 `DSH_PANEL_AUTOFOCUS=1` 再启动 VS Code，
扩展会自己把面板展开一次 —— 这样在无人值守时也能验证「装上 → 激活 → 开面板 → 连上」
整条链路，不用手点。

```powershell
$env:DSH_PANEL_AUTOFOCUS='1'; code --new-window .
```

测试用的档、端口、命令都可以用环境变量覆盖（默认指向 `dshdoor` 这个测试档，
**刻意不用 `desktop`** —— 测试不该有权限去拉起你真实的那一档）：

```powershell
$env:DSH_PANEL_PROFILE='dshdoor'; $env:DSH_PANEL_PORT='47821'; node test/run-all.js --all
```
