# DSH Panel

在 VS Code 的侧边栏里使用**你正在运行的** DeepSeek Harness。

它不是另一个 agent，也不会另起一套记忆：它连的是你桌面端那个 DSH 内核 ——
同一份配置、同一份记忆、同一份会话记录、同一套工具与权限策略。

## 它是怎么接上去的

```
VS Code 侧边栏（本扩展）
        │  ACP（JSON-RPC，一行一个 JSON）
        ▼
   「门」插件 dsh-acp-door           ← 装在 DSH 内核里的一个小插件
        │  在本机回环端口 47821 上再挂一份 ACP 桥
        ▼
   正在运行的 DSH 内核               ← 你在用的那一个
```

- 门**只监听本机回环地址**，不接受外部连接。
- 桌面端没在跑时，扩展会自动在后台拉起一个 DSH，用的是**你桌面端那一档**
  （`dshPanel.fallbackProfile`，默认 `desktop`），所以记忆、技能、插件完全一致，
  只是没有窗口。它和桌面端**共用同一份 `$DSH_HOME`**，记忆和会话记录仍然是同一份。

### 门要装进哪个档

门插件装在哪个 profile 里，面板就连得上哪个 profile 的 DSH。
本项目把它装进了用户的 `desktop` 档（记录与卸载方法见 `docs/第1步-装进桌面端.md`），
于是「先开桌面端、再开 VS Code」时，面板连的就是桌面端那个**正在跑的进程**。

**注意**：插件是在内核启动时加载的。装完之后，已经在跑的桌面端不会立刻有门 ——
要么重启一次桌面端（得到一个进程、一个大脑的最优状态），
要么就让扩展自己拉一个后台内核（同一档、同一份记忆，只是多一个进程）。

### 受限模式（Restricted Mode）也没问题

清单里声明了 `capabilities.untrustedWorkspaces.supported = true`。

这一条不是装饰：**不声明它的扩展，在 VS Code 的受限模式里会被整个禁掉** ——
表现是"面板凭空消失，还不报错"，非常难查（真在隔离窗口里踩到过：
同一个扩展，不带工作区文件夹能激活，带一个未被信任的文件夹就完全不加载）。
本扩展不执行工作区里的代码：读工作区文件只发生在你主动右键「带进对话」时，
设置也只读用户级设置（受限模式下 VS Code 本来就不套用工作区设置）。

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

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dshPanel.host` | `127.0.0.1` | 「门」的监听地址 |
| `dshPanel.port` | `47821` | 「门」的端口，要和门插件里写的保持一致 |
| `dshPanel.autoStart` | `true` | 连不上时自动在后台拉起一个 DSH |
| `dshPanel.fallbackProfile` | `desktop` | 后台拉起时用哪个 profile（里面要装好门插件）。默认就是用户自己那一档 |
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
- **权限模式**同理，ACP 没暴露；桌面端的默认策略仍然生效。
- **历史会话列表**：ACP 的 `session/list` 只返回 `{sessionId, cwd}`，
  没有标题也没有时间，所以面板暂时不做历史列表。
- 图片粘贴不支持（内核实测 `promptCapabilities.image = false`）。

## 出问题怎么办

1. 先跑 `DSH：查看日志`，看有没有「连不上」「握手失败」。
2. 手动确认门在不在：`Test-NetConnection 127.0.0.1 -Port 47821`。
3. 确认门插件装好了：`dsh plugin --profile <你的 profile> list`。

## 开发

扩展是**纯 JavaScript、零运行时依赖、无构建步骤** —— 改完文件直接重载窗口即可。

一条命令跑完全部测试（内核没开的话，测试会自己按需拉起、跑完自己收）：

```powershell
node test/run-all.js        # 快速套件：静态契约 + 拼块单测 + Markdown 单测 + 面板层，约 15s
node test/run-all.js --ui   # 再加上真浏览器里的界面断言（需要 Chrome）
node test/run-all.js --all  # 再加上真 DSH 进程的兜底拉起、模式、端到端，约 2 分钟
```

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
node test/fallback.js    # 兜底路径：桌面端没在跑时能否自己拉起来、收摊能否杀干净
node test/resume.js      # 断线后 session/resume 到底能不能把上下文接回来（带对照组）
node test/presets.js     # 模式（agent preset）：新会话挂上、恢复会话补挂、工具没丢
node test/smoke.js       # 端到端：协议、真回合、工具调用、中断、切模型、多轮、
                         #   以及编辑器上下文（选中代码里的暗号 + 带进来的文件里的暗号）
node tools/uitest.js     # 无头 Chrome 里对界面做 387 项断言（9 个场景，含通用视觉体检：
                         # 文字截断 / 按钮太小 / 浮层跑出面板 / 消息间距不一致）
node tools/uitest.js context  # 只跑「带编辑器上下文」那个场景
node tools/shots.js      # 把每个场景 × 深/浅主题拍成图（shots/*.png），
                         # 用于"用眼睛看"和改动前后对比。加场景名可只拍一个。
node tools/design-audit.js  # 界面尺度审计：字号/间距/行高/圆角各有几种、有没有硬编码颜色。
                         # 美化那一步用它量"改前改后"；加 --strict 时有硬编码颜色就非 0 退出。
node tools/build-vsix.js # 打包成 vsix

# 下面四个是「排查用」的，不是测试套件的一部分，也不打进 vsix（只 ship src/media/README/package.json）。
# 它们跑的是你这台机器的真实环境，所以只适合手动跑：
node tools/check-installed.cjs     # 装进 VS Code 的那份和仓库源码是否逐字节一致
                                   # （判断"用户跑的是不是当前源码"—— 出过一次"改了源码但没装"）
node tools/check-local-history.cjs # 面板"自己读盘"这条路在真机上看到了什么：
                                   # 磁盘几段、读到几段、有没有解码失败、耗时、列表上限截掉多少
node tools/who-owns-door.cjs       # 47821 上那个门是谁开的（桌面端自己的内核？测试留下的孤儿？）
                                   # 门没开时会告诉你面板将走"兜底拉起"
node tools/check-eol.cjs           # 有没有文件混着 CRLF 和 LF（逐字节比对最怕这个；混了就非 0 退出）
                                   # 从任何目录跑都一样，不依赖当前工作目录

node tools/vscode-check.js  # **真 VS Code 窗口里**的自检：开一个隔离窗口（自己的 user-data-dir 和
                            # extensions-dir，不碰你正开着的窗口），用 DSH_PANEL_AUTOFOCUS=1 让它
                            # 自动展开面板，断言 11 条：窗口起来 / 扩展激活 / 五个命令注册 /
                            # 视图进活动栏 / 面板展开 / ACP 握手 / 建出会话 /
                            # 内核这件事（47821 上有门就是「接入模式：不许另起内核」，
                            # 没门就是「兜底模式：必须自己拉起来」）/ 收摊干净 /
                            # 不留孤儿内核 / 你自己的窗口没被动。约 30 秒，跑完自动收摊。
                            # 加 --keep 可以留着窗口自己看。
                            # **一个内核都不杀**：只收自己开的那个隔离窗口，剩下的只报告 ——
                            # 靠名字/参数去 taskkill 是有可能误伤你自己正在用的内核的。
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
