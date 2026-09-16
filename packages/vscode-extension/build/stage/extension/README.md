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
- 桌面端没在跑时，扩展会按你的设置自动在后台拉起一个 DSH。它和桌面端
  **共用同一份 `$DSH_HOME`**，所以记忆和会话记录仍然是同一份，不是另立门户。

## 用法

1. 点侧边栏的 DSH 图标（活动栏里那个对话气泡）。
2. 直接提问。Enter 发送，Shift+Enter 换行。
3. 顶栏是模型下拉与上下文用量；右上角是「新建对话」与「重新连接」。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dshPanel.host` | `127.0.0.1` | 「门」的监听地址 |
| `dshPanel.port` | `47821` | 「门」的端口，要和门插件里写的保持一致 |
| `dshPanel.autoStart` | `true` | 连不上时自动在后台拉起一个 DSH |
| `dshPanel.fallbackProfile` | `dshdoor` | 后台拉起时用哪个 profile（里面要装好门插件） |
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

```powershell
node test/static.js     # 静态契约：id、消息协议、CSS 类、零硬编码颜色
node test/panel.js      # 面板层集成测试（注入假 vscode，连真的门）
node test/smoke.js      # 端到端：协议、回合、中断、切模型
node tools/build-vsix.mjs
```

测试需要一个 DSH 在 47821 上开门：

```powershell
dsh --profile dshdoor --no-open --port 0
```
