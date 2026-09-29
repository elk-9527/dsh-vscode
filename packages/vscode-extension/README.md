# DSH ACP Panel

**在 VS Code 里直接使用 DeepSeek Harness。**

无需在编辑器和桌面端之间来回切换：你可以在侧边栏与 DSH 对话，把当前文件或选中的代码带入上下文，查看工具执行过程，切换模型、对话模式与权限，并继续本机已有的历史会话。

面板会优先连接正在运行的 DSH；没有可用连接时，也可以按需启动一套独立的本机配置。会话、记忆和模型设置仍由你自己的 DSH 管理。

## 你可以做什么

- **在侧边栏对话**：发送消息，阅读 Markdown 回复，并实时查看思考内容与工具执行状态。
- **把代码带进对话**：通过编辑器右键菜单附加当前文件或选中的代码，无需手工复制粘贴。
- **切换模型与模式**：直接使用 DSH 提供的模型和 agent preset；模式变更会应用到下一段新对话。
- **控制会话权限**：查看并切换当前会话的权限，高风险模式启用前会再次确认。
- **继续历史会话**：浏览保存在本机的 DSH 会话，回看内容或接回原有上下文。
- **自动连接与恢复**：连接已有 DSH，或按需启动本机 DSH；断线后会在下一次发送时重新连接并尝试恢复会话。

## 快速开始

### 1. 安装扩展

在 VS Code 扩展市场搜索 **DSH ACP Panel**，或运行：

```sh
code --install-extension Elk-ydy.dsh-acp-panel
```

使用本地 `.vsix` 时：

```sh
code --install-extension <文件路径>.vsix --force
```

安装或更新后，执行一次 **Developer: Reload Window**。

### 2. 准备本机 DSH

请先安装 DSH，并在 DSH 中配置一个可用模型。本扩展还需要 ACP 接入点插件（`dsh-acp-door`）提供本机连接。

安装扩展后，打开命令面板并运行：

> **DSH：准备或修复自启配置**

该命令会创建缺失的 `vscode-panel` web 配置集，安装或更新 ACP 接入点插件，并把桌面端已启用的注册表插件按当前实际版本同步过来。已有的同名非 web 配置集不会被覆盖。

也可以手工准备：

```sh
dsh --profile vscode-panel --from-default-profile web --dump-config
dsh plugin --profile vscode-panel add dsh-acp-door
dsh plugin --profile vscode-panel list
```

不要把自启配置集设为 `desktop`：该配置集由桌面端管理，不能由命令行启动。

如果桌面端所用的配置集已经安装 ACP 接入点插件，重启一次桌面端后，面板会优先连接这套正在运行的 DSH。

### 3. 开始对话

点击 VS Code 活动栏中的 DSH 图标，在侧边栏输入问题并按 `Enter` 发送；使用 `Shift+Enter` 换行。

## 两种连接方式

| 场景 | 面板行为 | 需要准备 |
| --- | --- | --- |
| DSH 已在运行 | 直接连接并使用现有内核 | 对应配置集已安装 `dsh-acp-door` |
| DSH 未运行 | 同步桌面端插件后，按需启动 `vscode-panel` 配置集 | 已运行“准备或修复自启配置”，并配置可用模型 |

两种方式都只访问本机 DSH，不提供远程连接或云端同步。

## 常用操作

- 点击面板右上角的 `+` 新建对话。
- 点击时钟图标浏览、回放或接回历史会话。
- 在编辑器中右键，选择 **DSH：把选中的代码带进对话** 或 **DSH：把当前文件带进对话**。
- 使用面板顶栏切换模型、对话模式和权限。
- 在命令面板中搜索 `DSH`，可重新连接、查看日志、准备自启配置或停止面板启动的后台 DSH。

## 设置

打开 VS Code 设置并搜索 `DSH Panel`。

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `dshPanel.autoStart` | `true` | 没有可用连接时，允许面板启动本机 DSH |
| `dshPanel.fallbackProfile` | `vscode-panel` | 面板自行启动时使用的配置集 |
| `dshPanel.dshCommand` | `dsh` | 自动发现失败时使用的 DSH 命令覆盖项 |
| `dshPanel.kernelIdleMinutes` | `10` | 面板关闭后保留自启 DSH 的分钟数 |
| `dshPanel.port` | `47821` | 连接已运行 DSH 的本机端口 |
| `dshPanel.selfStartPort` | `47831` | 面板自行启动 DSH 时使用的本机端口 |
| `dshPanel.provider` / `dshPanel.model` | 空 | 为新会话成对指定初始模型；留空由 DSH 决定 |
| `dshPanel.preset` | 空 | 新对话使用的模式；留空使用 DSH 默认值 |
| `dshPanel.cwd` | 空 | 新会话的工作目录；留空使用当前工作区 |

大多数情况下，只需确认 `fallbackProfile`。扩展会自动查找 DSH Desktop 0.2 的安装目录和随附运行时；只有自动发现失败时才需要填写 `dshCommand`。端口设置通常保持默认即可。

## 本机数据与安全

- 连接仅限 `127.0.0.1` / `localhost`，不支持远程 DSH。
- 本机连接没有身份验证，请勿通过端口转发、隧道或局域网将其暴露出去。
- 会话、记忆和模型配置由本机 DSH 管理，扩展不提供云端同步。
- 自启配置集与桌面端共用同一份 `$DSH_HOME`。扩展会把桌面端已启用的注册表插件同步到默认的 `vscode-panel`；`file:`、Git、URL 等只在原安装现场有效的来源不会自动复制，详情写入 **DSH Panel** 日志。
- 只有主动执行“带进对话”时，当前文件或选区才会作为上下文附加。

## 系统要求

- VS Code 1.85 或更高版本。
- 本机已安装 DSH，并配置了可用模型。
- 已安装 ACP 接入点插件（`dsh-acp-door`）。
- 兼容 DSH `0.1.5-rc.2` 与 `0.2.0-rc.1`。

当前界面语言为中文，暂不支持粘贴图片。完整端到端验证环境为 Windows；其他系统暂未列入已验证兼容性范围。

## 遇到问题

1. 在命令面板运行 **DSH：查看日志**，查看连接或启动失败的原因。
2. 运行 `dsh plugin --profile vscode-panel list`，确认 ACP 接入点插件已经安装。
3. 安装或更新插件后重启对应的 DSH；更新扩展后执行 **Developer: Reload Window**。
4. 运行 **DSH：准备或修复自启配置**，自动创建或修复 `vscode-panel`。
5. 如果自动发现仍然失败，再在 `dshPanel.dshCommand` 中填写完整启动命令。

仍有问题时，请在 [GitHub Issues](https://github.com/elk-9527/dsh-vscode/issues) 提交日志与复现步骤。版本变化请查看[更新记录](CHANGELOG.md)。

<details>
<summary>English</summary>

DSH ACP Panel brings DeepSeek Harness into the VS Code sidebar. Chat with DSH, attach the current file or selected code, inspect tool activity, switch models and permissions, and resume local sessions without leaving the editor.

The extension connects to an existing local DSH instance or starts a dedicated local profile on demand. It requires VS Code 1.85+, a configured DSH installation, and the companion `dsh-acp-door` plugin. Connections are loopback-only, and the current UI is Chinese.

</details>
