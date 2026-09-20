# DSH in VS Code

在 VS Code 侧边栏中接入 [DeepSeek Harness](https://github.com/deepseek-ai)（以下简称 DSH）：
无需先启动桌面端即可直接提问。记忆、会话记录、插件与桌面端共用同一份 `$DSH_HOME`。

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

## 安装

```sh
# 1) 为 DSH 安装插件（安装到日常使用的 profile；完成后重启内核或桌面端）
dsh plugin --profile <profile> add dsh-acp-door

# 2) 安装 VS Code 扩展
code --install-extension <publisher>.dsh-panel
```

市场入口：VS Code 市场搜索 **DSH Panel**；DSH 插件市场搜索 **dsh-acp-door**。

## 开发

```sh
pnpm install

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
