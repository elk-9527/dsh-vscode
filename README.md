# DSH in VS Code

在 VS Code 侧边栏中接入 [DeepSeek Harness](https://github.com/deepseek-ai)（以下简称 DSH）：
无需先启动桌面端即可直接提问。接入桌面端时使用同一个运行内核；自行启动时使用同一
`$DSH_HOME` 下已准备的 DSH 配置集。

本仓库由两个组成部分构成，两者都需要安装。

| 包 | 内容 | 安装位置 |
| --- | --- | --- |
| [`packages/vscode-extension`](packages/vscode-extension)（`dsh-panel`） | VS Code 扩展：侧边栏面板，本身即 ACP 客户端 | VS Code 市场 / `.vsix` |
| [`packages/dsh-door`](packages/dsh-door)（`dsh-acp-door`） | DSH 插件：在运行中的内核上提供仅监听 `127.0.0.1` 的 ACP 接入点 | `dsh plugin add` / DSH 插件市场 |

## 为什么需要两个组成部分

ACP 默认使用标准输入输出传输，该通道只能在进程启动时建立，而桌面端此时已经启动并持有内核。
因此由插件在内核内提供一个仅监听本机回环地址的接入点，扩展连接到该接入点：

```
VS Code ── DSH Panel 扩展（ACP 客户端）
              │  ACP over 127.0.0.1:47821
              ▼
        dsh-acp-door（插件：本机 ACP 接入点）
              │
              ▼
        运行中的 DSH 内核（agents / 会话 / 记忆 / 工具 / 权限）—— 只有一份
```

扩展驱动的是同一个 DSH 实例，不产生第二个 agent，也不产生第二份记忆。

## 两种运行模式

| 模式 | 使用时机 | 实际行为 | 需要准备的内容 |
| --- | --- | --- | --- |
| 接入现有内核 | 桌面端正在运行，且接入点已开放 | 面板连接同一个运行内核；会话、模型、工具和权限状态完全一致 | 桌面端配置集已安装接入点插件，并在安装后重启过内核 |
| 面板自行启动 | 桌面端未运行，或现有内核不可用 | 面板启动 `vscode-panel` 配置集；仍使用本机同一份 `$DSH_HOME` | 在 `vscode-panel` 中安装接入点插件和所需的个人插件，并确保 DSH 已选择默认模型 |

DSH 的会话、记忆与默认模型设置来自同一份 `$DSH_HOME`；各配置集内安装的依赖和补丁仍独立维护。
因此自行启动的配置集会使用 DSH 当前默认模型，但不会自动复制桌面端配置集中的个人插件。

## 首次安装（每台电脑分别完成）

### 前提

- 已安装 VS Code 1.85 或更高版本，以及可正常启动的本地 DSH。
- DSH 中已有可用的模型服务商和模型。本项目不提供模型账号、模型凭据或远程 DSH 服务。
- 本项目的完整端到端验证环境为 Windows；其它系统的启动分支保留在代码中，但尚未作为发布兼容性结论。

### 1. 准备面板使用的 DSH 配置集

桌面端已经运行且其中已安装配套插件时，面板会直接接入该内核。为了在桌面端未启动时仍可使用，
建议创建一个可由命令行启动的网页配置集，并在其中安装配套插件：

```sh
# 从 DSH 的 web 模板创建配置集（首次执行时）
dsh --profile vscode-panel --from-default-profile web --dump-config

# 安装配套插件，然后确认它已出现在清单中
dsh plugin --profile vscode-panel add dsh-acp-door
dsh plugin --profile vscode-panel list
```

插件安装后重启该配置集对应的 DSH 内核。插件会跟随该配置集中 DSH 当前选择的默认模型，
无需再次填写服务商与模型名；若该配置集尚未选择模型，请先在 DSH 中完成选择。仅在需要让
接入点固定到另一个模型时，才同时配置 `provider` 与 `model`。详见
[`packages/dsh-door/README.md`](packages/dsh-door/README.md#配置)。

### 2. 安装 VS Code 扩展

首次发布完成后，可在扩展视图搜索 **DSH Panel**，或执行：

```sh
code --install-extension Elk-ydy.dsh-panel
```

离线安装 `.vsix` 时，使用实际文件路径并在安装后执行一次 `Developer: Reload Window`：

```sh
code --install-extension <dsh-panel-版本>.vsix --force
```

打开活动栏中的 DSH 图标后即可开始对话。

### 其它电脑与后续更新

- 每台电脑都需分别安装 DSH、配套插件和 VS Code 扩展。面板不会把一台电脑的 DSH 暴露给另一台电脑，
  也不会同步或复制 `$DSH_HOME`；记忆、会话和插件状态以各机器本地 DSH 为准。
- 接入点固定监听 `127.0.0.1`，不支持改为局域网地址、端口转发或隧道访问。这样做会绕开本项目明确的
  本机安全边界。
- 从 VS Code 市场安装的扩展由 VS Code 按其更新设置升级；从 `.vsix` 安装的扩展需要重新安装新版
  `.vsix` 并执行 Reload Window。
- 配套插件的常规兼容更新，在目标配置集执行
  `dsh plugin --profile <配置集> update dsh-acp-door`，再重启该配置集的 DSH 内核。
  版本说明若标记为不兼容更新，应按该版本的安装说明处理。更新扩展和插件时，应同时阅读对应版本的更新记录。

## 开发

```sh
pnpm install --frozen-lockfile

# 扩展：单元与静态测试 + 界面回放测试
cd packages/vscode-extension
node test/run-all.js --all        # 全部测试
node tools/uitest.js              # 界面回放测试（无头 Chrome）
node tools/build-vsix.js          # 生成本地安装包
node tools/publish.js             # 市场发布前自检（自检 + 打包 + 文件清单比对）

# 插件：纯函数套件，以及端到端试验
cd packages/dsh-door
node test/frames.js               # 帧判定
node test/permission.js           # 权限预设方法
node test/port.js                 # 端口判定
node test/sessions.js             # 会话读取
node tools/publish.cjs            # npm 发布前自检，并生成上架所需的 yml
```

其中插件的四个套件也由扩展的 `test/run-all.js` 一并执行（见该文件中的套件清单）。

`node test/run-all.js` 是不依赖 DSH 的快速套件；`--all` 才会启动真实内核、写入专用测试档并执行
真实回合。仓库的 GitHub CI 只运行前者与打包检查，发布前仍须在本机执行一次 `--all`。

运行要求：Node ≥ 20、pnpm、本机已安装 DSH、Windows（界面回放测试在无头 Chrome 中执行）。

## 目录说明

- `docs/` —— 中文工作记录：交接文档、恢复方法、发布清单、界面设计基线。
  其中包含本机的绝对路径，属于工作记录，不是产品文档。
- [`docs/注释与文档规范.md`](docs/注释与文档规范.md) —— 本仓库中文文本的写作标准：源码注释与
  JSDoc、各 README、`docs/` 下的说明文档，以及面向用户的界面文案。
- `spike/` —— 早期用于确认 ACP 协议行为的探测脚本。
- `packages/*/test`、`packages/*/tools` —— 测试与诊断工具，均不进入发布包。

## 许可

MIT，见 [LICENSE](LICENSE)。
