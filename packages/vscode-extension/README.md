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
- **审查代码变更**：从源码管理或命令面板启动 Code Review，在 Problems 中定位发现，并打开完整报告。
- **浏览技能**：点击“工具”中的“浏览技能”，搜索并打开技能说明，支持内置技能和文件技能。
- **查看插件运行**：原生运行视图显示审查进度，支持取消和同一内核上的断线恢复。
- **诊断安装与加载**：查看当前连接、配置集版本与来源，以及内核实际注册的能力；复制诊断结果时不包含模型配置和凭据。
- **重新运行与清理**：显式重跑已结束审查，使用新的代码快照；清理旧记录时保留活动任务和已经打开的报告。
- **在原生 Chat 使用 DSH**：输入 `@dsh`，或使用 `/review`、`/skills`、`/new` 和 `/open-panel`。
- **管理文件技能**：从“工具”的更多菜单打开技能管理，编辑草稿、预览差异，再确认新建、更新、启用、删除或恢复。

代码审查、技能浏览与运行恢复需要接入点 `0.2.0` 及已注册 Bridge 能力的试点插件。当前使用本地候选包；旧接入点或原版插件下，聊天继续可用。

“工具”视图只保留“审查代码”和“浏览技能”两个直接入口。技能状态通过命令面板中的 **DSH：检查技能状态** 查看，以中文说明呈现加载结果。

## 原生 Chat 与技能管理

原生 Chat 集成在同一个扩展里，使用现有 DSH 模型、配置和连接。稳定版需要 [VS Code 1.91 或更高版本的 Chat API](https://code.visualstudio.com/updates/v1_91)及可用的 Chat 界面。缺少此 API 时继续使用侧栏。`@dsh` 会保存 DSH 会话 metadata，“在 DSH 面板继续”按钮和 `/open-panel` 恢复同一会话，`/new` 开始新对话。取消中止对应请求，权限请求仍需选择 DSH 实际提供的选项。

执行 **DSH：管理技能**。新建或编辑打开未保存的 Markdown 草稿；修改后执行 **DSH：预览并应用技能修改**，查看完整差异并点击“确认应用”。关闭确认不会写入技能。用户技能影响所有项目，确认时显示范围。来源或正文在预览后变化时拒绝提交，需重新预览。

仅当前项目和用户目录下的 `.dsh/skills`、`.agents/skills` 文件技能可修改；系统、运行时、自定义来源和符号链接技能只读。正文上限为 128 KiB，修改使用临时文件与回读核验。原正文保存在技能文件旁的 `.trash`，删除保留其他资源；恢复已删除技能时不覆盖同名文件。编辑不改名，需要另一个名称时新建技能。技能写入要求接入点 `0.2.1`、SDK 及技能试点 `0.4.4-ide.3`，早期候选仍提供只读浏览。

供其他扩展使用的会话、流式提示、能力调用和事件接口见 [公共 API](API.md)。

## 安装与运行诊断

从命令面板执行 **DSH：诊断连接与配置**，分别查看磁盘安装清单和当前内核能力。清单引用某个插件不证明插件已经加载；无法确认外部内核所属配置集时，诊断会明确标记“尚未确认”。**DSH：复制连接与配置诊断**复制所显示的元数据，不包含依赖 URL、模型密钥或引导令牌。

**DSH：查看插件安装说明**先选择目标网页配置集，再展示插件、精确版本与来源。只有已确认的注册表来源提供显式安装动作；安装前备份目标配置、锁文件和旧包，安装后回读版本和引用清单。本地候选、Git 和未知来源保留手工说明，未发布的试点候选版本不会生成注册表安装命令。安装后仍需加载内核并刷新能力。

**DSH：重新加载面板后台内核**仅处理扩展启动且空闲的内核；运行任务或聊天工作时不执行。外部内核需在所属应用重新加载。该动作会结束后台内核的空闲会话。

运行记录右键菜单提供 **重新运行审查**和**移除已结束记录**。重试创建新的运行，保留原记录；窗口重开后，自定义要求需重新输入。记录恢复只查询原任务，不会重新调用模型；内核变化、记录过期或工作区变化时显示无法恢复。**DSH：清理已结束记录**保留进行中、取消中和待恢复任务。

已完成且保有完整报告的记录提供 **将审查结果带入对话**，也可从同名命令选择报告。报告附加到现有输入框，可补充问题、查看附件提示中的正文或移除附件；点击发送后才交给模型。报告属于审查时的代码快照，代码变化时会显示提示。此操作需要受信任的同一工作区，超过 256 KiB 的报告需选择部分内容后发送。

当前工作区最多保存 100 条已结束运行的元数据，不持久保存完整报告或自定义审查要求。已经打开的只读报告在关闭前仍可阅读；清理仅移除对应的 DSH 问题提示。界面使用 VS Code 原生树、文字、主题图标和命令入口，支持键盘操作与高对比主题。

本轮完整原生流程使用 VS Code 1.140 验收。最低声明版本 1.85 在当前 Windows 环境仍有启动及端点身份核对限制；相关失败单独记录，不能视为原生审查流程已通过。身份无法确认时限制插件执行，普通聊天与只读诊断保留。

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

该命令会创建缺失的 `vscode-panel` web 配置集，安装或更新 ACP 接入点插件，并把桌面端已启用的注册表插件按当前实际版本同步过来。DSH 运行时自带且已在桌面配置集中启用的官方 bundle（例如提供 `auto` 权限的自动授权审查）也会同步。后台启动时还会只读加载 `desktop/cordis.patch.yml`，继承模型路由、插件开关和参数；不会复制或覆盖任一配置文件。已有的同名非 web 配置集不会被覆盖。

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
- 自启配置集与桌面端共用同一份 `$DSH_HOME`。扩展会把桌面端已启用的注册表插件和当前 DSH 运行时自带的官方 bundle 同步到默认的 `vscode-panel`，并在启动时只读叠加 desktop 的模型路由、插件开关与参数；`file:`、Git、URL 等只在原安装现场有效的来源不会自动复制，详情写入 **DSH Panel** 日志。
- 只有主动执行“带进对话”时，当前文件或选区才会作为上下文附加。

## 系统要求

- VS Code 1.85 或更高版本。
- 本机已安装 DSH，并配置了可用模型。
- 已安装 ACP 接入点插件（`dsh-acp-door`）。
- 兼容 DSH `0.1.5-rc.2`、`0.2.0-rc.1` 与 `0.2.0-rc.2`。

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
