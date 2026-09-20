# DSH in VS Code

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）搬进 VS Code 的侧边栏：
点开面板就能提问，**不用先打开桌面端**；记忆、会话记录、插件与桌面端共用同一份
`$DSH_HOME`。

这个仓库里是它的**两半** —— 一个 VS Code 扩展，和一个 DSH 插件。两个都要装。

| 包 | 是什么 | 装在哪 |
| --- | --- | --- |
| [`packages/vscode-extension`](packages/vscode-extension)（`dsh-panel`） | VS Code 扩展：侧边栏面板，自己就是 ACP 客户端 | VS Code 市场 / `.vsix` |
| [`packages/dsh-door`](packages/dsh-door)（`dsh-acp-door`） | DSH 插件：在**正在运行的内核**上多开一扇只监听 `127.0.0.1` 的 ACP 门 | `dsh plugin add` / DSH 插件市场 |

为什么需要两半：ACP 默认走标准输入输出，那根线只能在进程**启动的那一刻**接上；
而你桌面端已经开着了。所以由插件在内核里开一扇本机端口，扩展再连上去 ——
驱动的是**同一个** DSH，不是第二个 agent、也不是第二份记忆。

```
VS Code ── DSH Panel 扩展
              │  ACP over 127.0.0.1:47821
              ▼
        dsh-acp-door（插件）
              │
              ▼
        正在运行的 DSH 内核（agents / 会话 / 记忆 / 工具 / 权限）—— 只有一份
```

## 装

```sh
# 1) 给 DSH 装上插件（装进你平时用的那个档；装完重启内核/桌面端）
dsh plugin --profile <你的档> add dsh-acp-door

# 2) 装 VS Code 扩展
code --install-extension <publisher>.dsh-panel
```

市场：VS Code 市场搜 **DSH Panel**；DSH 插件市场搜 **dsh-acp-door**。

## 开发

```sh
pnpm install

# 扩展：单元/静态测试 + 界面回放测试
cd packages/vscode-extension
node test/run-all.js --all        # 全部测试
node tools/uitest.js              # 界面回放（几百项断言）
node tools/build-vsix.js          # 打本地安装包
node tools/publish.js             # 市场发布彩排（自检 + 打包 + 文件清单比对）

# 插件：开一扇门做端到端试验
cd packages/dsh-door
node test/run-all.js
node tools/publish.cjs            # npm 发布彩排 + 生成上架要提的那个 yml
```

要求：Node ≥ 20、pnpm、本机装了 DSH、Windows（界面测试用无头 Chrome 回放）。

## 目录里还有什么

- `docs/` —— 中文工作笔记：交接文档、恢复方法、发布清单、界面设计基线。
  **里面有这台机器的绝对路径**，属于工作记录，不是产品文档。
- `spike/` —— 最初摸 ACP 协议时的探针脚本。
- `packages/*/test`、`packages/*/tools` —— 测试与诊断工具，都不进发布包。

## 许可

MIT，见 [LICENSE](LICENSE)。
