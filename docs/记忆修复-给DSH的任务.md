# 任务：修复 DSH 的长期记忆（Hindsight），从零开始，不要同步 Hermes

> 用法：把下面 `---` 之间的内容整段复制，新开一个 DSH 对话贴进去发出去。

---

## 背景

我用的是 DSH Desktop，profile 是 `desktop`，装了插件 `@vectorize-io/hindsight-coding-agents@0.6.1`（在 `C:\Users\Lenovo\.dsh\profiles\desktop`）。

我之前删掉了一个「和 Hermes 记忆同步」的插件，从那以后记忆就坏了。
**我不想要 Hermes 的同步**。我要一个**全新的、只属于 DSH 的记忆系统，从零开始养**。

现在 DSH 的记忆工具全部报错：`connect ECONNREFUSED 127.0.0.1:9077`。

## 已经确认的事实（请先自己复核一遍，不要直接当结论）

1. `C:\Users\Lenovo\.hindsight\coding-agent.json` 的内容是 `{"serverMode": "daemon"}`。
2. `127.0.0.1:9077` 端口上**没有任何程序在监听**。
3. `C:\Users\Lenovo\.hindsight\coding-agents-logs\plugin.log` 里反复出现两类信息：
   - `reflect failed — session runs without memory {"error":"fetch failed: connect ECONNREFUSED 127.0.0.1:9077 (ECONNREFUSED)"}`
   - `daemon mode needs an LLM for fact extraction — set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY / HINDSIGHT_API_LLM_PROVIDER), or install the Claude Code CLI`
4. 日志显示**以前是好的**：曾出现过 `memory bank "coding-agent::Lenovo"`，现在按项目分库，成了 `coding-agent::dsh-vscode`。

## 我要的结果

1. DSH 的长期记忆**重新能用**：对话过程中自动提炼事实，之后**在别的对话里也能被召回**。
2. **不要**引入 Hermes 或任何外部记忆源的同步。
3. 保持「按项目分库」的行为（现在是 `coding-agent::dsh-vscode`），我要从零开始养一套干净的。

## 约束（重要）

- **先诊断、先报告，再动手。** 改任何文件之前，先把你的方案和要改的清单列给我确认。
- 不要改动 `desktop` profile 里**除记忆相关之外**的其他插件。
- 不要删除我已有的会话记录。
- 如果要**花钱**或要**新的 API 钥匙**，先停下来问我，说明花谁的钱、大概多少、钥匙放在哪。

## 请你回答这四个问题

1. `serverMode: "daemon"` 到底需要一个什么服务？它在哪？是插件自带的，还是要单独安装（npm / Docker / 独立程序）？
2. 能不能改成**不需要单独服务**的模式（比如进程内模式）？那样最省事，优先考虑。
3. 「daemon mode needs an LLM for fact extraction」——这个负责提炼记忆的 AI，**能用我现有的 DeepSeek 吗**？（我在 DSH 里配的是 `opencode-go` 路由。）`HINDSIGHT_API_LLM_PROVIDER` 接受哪些值？能不能填一个 OpenAI 兼容的自定义地址？
4. 如果 Hindsight 确实修不好：请**先对比几个 star 最多的替代长期记忆插件**，把利弊列清楚让我选，**不要直接替换**。

## 交付

- 记忆工具恢复正常（能在新对话里召回旧对话里的事实），并给我一个可复现的简单验证方法。
- 一份简短说明：你改了什么、装了什么、以后我要注意什么。
- 如果这个问题需要跨多次对话才能做完，请把**进度写进一个文件**里，方便下次接着做。

---

## 附：给用户的备注（不用贴进对话）

- 这份任务**独立于** VS Code 插件项目，互不干扰。
- 如果 DSH 提出要钥匙或要花钱，**先别急着答应**，回来告诉我，我帮你判断划不划算。
- 修完之后，回来告诉我结果，我会把「记忆能不能用」记进插件的验收清单。
