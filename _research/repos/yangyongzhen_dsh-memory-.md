### REPO: yangyongzhen/dsh-memory  SUBDIR:   BRANCH: 
META default_branch=main stars=1 forks=0 pushed_at=2026-08-15T03:03:18Z created_at=2026-08-15T03:03:12Z license= archived=False open_issues=0 homepage=
META description=
RELEASE none
COMMIT 79d5bfa 2026-08-15T03:00:58Z :: feat: initial release
COMMIT 49274d2 2026-08-15T03:00:44Z :: feat: initial release
TREE FILECOUNT=18
--- FILES IN SCOPE (max 120) ---
F .gitignore
F README.md
F cordis.patch.yml
F lib/index.d.ts
F lib/index.js
F lib/render.d.ts
F lib/render.js
F lib/store.d.ts
F lib/store.js
F package.json
F pnpm-lock.yaml
F pnpm-workspace.yaml
F src/index.ts
F src/render.ts
F src/store.ts
F test/smoke.test.mjs
F test/store.test.mjs
F tsconfig.json
=== README FROM: https://raw.githubusercontent.com/yangyongzhen/dsh-memory/main/README.md (len=2826) ===
# dsh-memory

DeepSeek Harness 的长期记忆插件：把跨会话需要记住的事情（用户偏好、项目事实、会话摘要、可复用知识）持久化到磁盘，并在**每个新会话开始时自动注入**给 Agent。

## 特性

- **四类记忆**：`preference`（偏好，应默认遵守）、`fact`（项目/环境事实）、`summary`（会话/任务摘要）、`knowledge`（可复用知识/经验）
- **两种作用域**：`global`（所有项目适用）、`project`（按项目隔离，slug 自动从会话 cwd 推导）
- **四个 Agent 工具**：`memory_write` / `memory_read` / `memory_search` / `memory_delete`
- **会话开始自动注入**：监听 `agent/pre-step`，在第一步把全局+项目记忆渲染成带字节预算的 `<system-reminder>` 注入；内容寻址去重，resume 会话不会重复注入
- **原子持久化**：临时文件 + rename，崩溃不产生撕裂文件；损坏的 unit 优雅降级为空而不是崩溃
- **半自动**：写入由 Agent 判断（建议先 `memory_search` 查重再写），符合你的「半自动」选型

## 安装

```sh
dsh plugin --profile <name> add dsh-memory
# 或从本地 checkout 安装
cd <dsh-memory目录> && dsh plugin --profile <name> add .
```

## 配置

在 profile 的 `cordis.patch.yml`（或 `--patch` 覆盖）中配置：

```yaml
- id: memory
  config:
    enabled: true
    root: C:/Users/<you>/.dsh/memory   # 可选；默认 $DSH_HOME/memory（支持 ~ 前缀）
    maxBytes: 4000         # 注入预算（UTF-8 字节），默认 4000
    maxEntryBytes: 512     # 注入时单条内容上限，默认 512
    injectOnStart: true    # 会话开始自动注入，默认 true
    searchLimit: 20        # memory_search 默认返回上限，默认 20
```

## 工具

### `memory_write`

```json
{
  "type": "preference",
  "scope": "global",
  "content": "用户偏好中文回复",
  "tags": ["language"],
  "importance": 4
}
```

- `type`: `preference` | `fact` | `summary` | `knowledge`（必填）
- `scope`: `global` | `project`（必填；`project` 自动绑定当前会话 cwd）
- `content`: 记忆内容（必填）
- `id`: 已存在记忆的 id，传了则更新该条
- `tags`: 检索标签（可选）
- `importance`: 1..5 重要度（可选，注入与搜索排序参考）

### `memory_read`

按作用域（+ 可选类型过滤）列出记忆，最新在前。

### `memory_search`

在全局+当前项目记忆中检索：`query`（内容/标签不区分大小写包含匹配，多词须全命中）、`tags`（交集）、`type` 过滤；按重要度、再按更新时间排序。

### `memory_delete`

按 `id` + `scope` 删除一条记忆。

## 数据布局

```
$DSH_HOME/memory/
├── global.json                # 全局记忆（数组，version: 1）
└── projects/
    └── <slug>.json            # 每个项目一个 unit 文件
```

每条记录：

```json
{
  "id": "…",
  "type": "preference",
  "scope": "global",
  "content": "…",
  "tags": [],
  "importance": 3,
  "createdAt": "2026-08-20T…",
  "updatedAt": "2026-08-20T…"
}
```

## 工作原理

1. **存储**（`src/store.ts`）：`MemoryStore` 按作用域管理 JSON unit 文件，`put`/`remove`/`clear` 全部原子写；搜索按重要度+时间排序。
2. **渲染**（`src/render.ts`）：`renderMemoryBlock` 把条目逐条贪心装入 `<system-reminder>`，严格遵守 `maxBytes` 预算；放不下的条目跳过而不是丢整个 section。
3. **注入**（`src/index.ts`）：`agent/pre-step` 水瀑布中，仅 `step === 1` 且尚未注入过时，把渲染块追加到 claimed messages 之后进入第一次请求。source 带 `plugin: 'memory'` + `digest`，`alreadyInjected` 通过扫描会话 surface 去重，resume 安全。

## 开发

```bash
pnpm install
pnpm run build     # tsc → lib/
pnpm test          # store 单测（11 项）+ smoke（5 项）
```

## 设计取舍

- **半自动写入**：注入块会提示 Agent「如需更新记忆，使用 memory_write / memory_delete」，由 Agent 判断何时沉淀；不做全自动摘要（那需要额外 LLM 调用）。
- **预算优先**：注入默认 4000 字节，宁可少注入也不撑爆上下文；`importance` 高的条目优先。
- **文件即真相**：不用 SQLite/额外服务，`global.json` 人类可读可手改，和你的 `dsh-session-report` 风格一致。

## License

MIT

