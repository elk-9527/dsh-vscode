'use strict';

/**
 * 界面预览器：在真实浏览器中渲染 webview 的 HTML/CSS/JS，便于截图检查。
 *
 * 设置该脚本的原因：面板运行在 VS Code 的 webview 中，没有自动化手段可以可靠地
 * 打开并截图。界面层仅由三部分组成：一份 HTML 骨架、一份 CSS、一份 JS。
 * 将这三部分载入无头 Chrome，即可直接观察界面外观，无需依赖推测。
 *
 * 关键细节：HTML 骨架直接由 src/panel/html.js 中生产环境使用的函数生成，
 * 因此预览与真实界面不会脱节（修改 html.js 后预览立即随之变化）。
 *
 * 用法：
 *   node tools/preview.js             # 生成所有场景 × 深浅两套主题
 *   node tools/preview.js chat dark   # 只生成一个场景
 * 产物在 build/preview/ 下，用 Chrome 截图：
 *   chrome --headless=new --screenshot=shot.png --window-size=420,900 \
 *          --virtual-time-budget=3000 --user-data-dir=<临时目录> file:///.../chat-dark.html
 */

const fs = require('node:fs');
const path = require('node:path');
const { renderHtml, makeNonce } = require('../src/panel/html');
const { describeError } = require('../src/dsh/errors');
// 权限那条链路的界面文案（中文标签、确认环节）由生产代码生成，
// 预览与界面测试就不会与 src/dsh/permission.js 脱节。
const { decorateOptions } = require('../src/dsh/permission');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'preview');

/**
 * 主题变量。
 *
 * 注意：此处仅为预览使用的近似值（取自 VS Code 默认主题的公开色值），
 * 真实面板中不存在硬编码颜色，全部依赖 VS Code 注入的变量。
 * 这份表的作用是在没有编辑器的情况下也能查看真实观感。
 */
const THEMES = {
  dark: {
    '--vscode-font-family': "'Segoe UI', system-ui, sans-serif",
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': "Consolas, 'Courier New', monospace",
    '--vscode-sideBar-background': '#252526',
    '--vscode-sideBar-foreground': '#cccccc',
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-panel-border': '#3c3c3c',
    '--vscode-widget-border': '#313131',
    '--vscode-input-background': '#313131',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-border': '#3c3c3c',
    '--vscode-input-placeholderForeground': '#989898',
    '--vscode-dropdown-background': '#313131',
    '--vscode-dropdown-foreground': '#cccccc',
    '--vscode-dropdown-border': '#3c3c3c',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-secondaryBackground': '#3a3d41',
    '--vscode-button-secondaryForeground': '#cccccc',
    '--vscode-button-secondaryHoverBackground': '#45494e',
    '--vscode-focusBorder': '#0078d4',
    '--vscode-textLink-foreground': '#4daafc',
    '--vscode-textCodeBlock-background': '#1f1f1f',
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-editorWidget-background': '#202020',
    '--vscode-icon-foreground': '#cccccc',
    '--vscode-toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-progressBar-background': '#0e70c0',
    '--vscode-charts-green': '#89d185',
    '--vscode-charts-red': '#f14c4c',
    '--vscode-charts-yellow': '#cca700',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-testing-iconFailed': '#f14c4c',
    '--vscode-editorCursor-foreground': '#aeafad',
    '--vscode-diffEditor-insertedLineBackground': 'rgba(155, 185, 85, 0.2)',
    '--vscode-diffEditor-removedLineBackground': 'rgba(255, 0, 0, 0.2)',
    '--vscode-inputValidation-warningBackground': '#352a05',
    '--vscode-inputValidation-warningBorder': '#cca700',
    '--vscode-inputValidation-errorBorder': '#be1100',
  },
  light: {
    '--vscode-font-family': "'Segoe UI', system-ui, sans-serif",
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': "Consolas, 'Courier New', monospace",
    '--vscode-sideBar-background': '#f8f8f8',
    '--vscode-sideBar-foreground': '#3b3b3b',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-widget-border': '#e5e5e5',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-border': '#cecece',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-dropdown-background': '#ffffff',
    '--vscode-dropdown-foreground': '#3b3b3b',
    '--vscode-dropdown-border': '#cecece',
    '--vscode-button-background': '#005fb8',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0258a8',
    '--vscode-button-secondaryBackground': '#e5e5e5',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-button-secondaryHoverBackground': '#cccccc',
    '--vscode-focusBorder': '#005fb8',
    '--vscode-textLink-foreground': '#005fb8',
    '--vscode-textCodeBlock-background': '#f2f2f2',
    '--vscode-editor-background': '#ffffff',
    '--vscode-editorWidget-background': '#f8f8f8',
    '--vscode-icon-foreground': '#3b3b3b',
    '--vscode-toolbar-hoverBackground': 'rgba(184, 184, 184, 0.31)',
    '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-progressBar-background': '#005fb8',
    '--vscode-charts-green': '#388a34',
    '--vscode-charts-red': '#e51400',
    '--vscode-charts-yellow': '#bf8803',
    '--vscode-testing-iconPassed': '#388a34',
    '--vscode-testing-iconFailed': '#e51400',
    '--vscode-editorCursor-foreground': '#000000',
    '--vscode-diffEditor-insertedLineBackground': 'rgba(155, 185, 85, 0.2)',
    '--vscode-diffEditor-removedLineBackground': 'rgba(255, 0, 0, 0.2)',
    '--vscode-inputValidation-warningBackground': '#fff4ce',
    '--vscode-inputValidation-warningBorder': '#bf8803',
    '--vscode-inputValidation-errorBorder': '#e51400',
  },
};

// ── 场景：每一步要么向界面发送一条消息，要么仅等待一段时间 ──────────

const configMessage = {
  type: 'config',
  configOptions: [
    {
      id: 'model',
      name: '模型',
      currentValue: '["opencode-go","deepseek-v4.1-flash"]',
      options: [
        {
          group: 'opencode-go',
          name: 'opencode-go',
          options: [
            { value: '["opencode-go","deepseek-v4.1-flash"]', name: 'deepseek-v4.1-flash' },
            { value: '["opencode-go","deepseek-v4.1-pro"]', name: 'deepseek-v4.1-pro' },
          ],
        },
        {
          group: 'anthropic',
          name: 'anthropic',
          options: [{ value: '["anthropic","claude-sonnet-4"]', name: 'claude-sonnet-4' }],
        },
      ],
    },
  ],
};

/**
 * ACP 接入点插件（`dsh-acp-door`）在 session/new 回复中补全的预设清单（真实形状，依据该插件实现）。
 * 界面上的「模式」下拉即使用该清单渲染。
 */
const presetsMessage = {
  type: 'presets',
  current: 'standard',
  requested: 'standard',
  presets: [
    { id: 'standard', name: '标准模式', description: '功能完整的编码 Agent，支持文件编辑、Shell、检索、Skills、计划、目标、子代理和工作流。', order: 1 },
    { id: 'ptc', name: 'PTC 模式', description: '功能完整的编码 Agent，但默认不提供 workflow 工具。', order: 2 },
    { id: 'minimal', name: '极简模式', description: '仅提供持久 shell 的单工具编码 Agent。', order: 3 },
    { id: 'cordis', name: '创造模式', description: '用于创建自定义 Agent preset。', order: 4 },
  ],
};

/**
 * 权限选择器那一份状态（界面上顶栏的「权限」按钮与其展开的小卡片）。
 *
 * 选项由生产环境的翻译函数生成（`decorateOptions`），因此中文标签、
 * 说明以及「完全权限需要确认」这一约束，在预览与界面测试中的表现与真实面板一致；
 * 清单本身依据本机内核返回的四档记录（含 Auto Approval 插件增加的那一档）。
 */
const permissionStateMessage = {
  type: 'permissionState',
  currentValue: 'workspace-write',
  label: '工作区内修改',
  defaultPreset: 'auto-approval',
  options: decorateOptions(
    [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      {
        value: 'auto-approval',
        name: 'Auto Approval',
        description:
          'Workspace writes, plus automatic approval of harmless commands and operations targeting configured trusted areas (outside the workspace too); everything else asks.',
      },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
    'workspace-write',
  ),
};

const longAnswer = [
  '我看了一下你的 `packages/dsh-door/lib/index.js`，问题出在**服务依赖没有声明**。\n',
  '\n',
  '原因是 cordis 不允许在没有 `inject` 的情况下读服务属性：\n',
  '\n',
  '```js\n',
  "// ❌ 这样会抛：cannot get property \"agentPresets\" without inject\n",
  "ctx.on('agent/created', ({ agent }) => ctx.agentPresets.mount(agent, 'standard'));\n",
  '\n',
  '// ✅ 声明成硬依赖之后就可以读了\n',
  "export const inject = ['agents', 'agentPresets'];\n",
  '```\n',
  '\n',
  '要点有三个：\n',
  '\n',
  '1. 必须声明 `inject`，cordis 没有「可选依赖」这种写法；\n',
  '2. 挂预设是异步的，而第一个 `session/prompt` 可能比它先到，所以入站要压一下；\n',
  '3. 失败要吵 —— 用 `try/catch` 静默吞掉，就等于把这个坑埋起来。\n',
  '\n',
  '> 实测时序：`agent/created` → +55ms 收到 prompt（压住）→ +357ms 预设挂好 → 放行。\n',
  '\n',
  '要我直接把改动写进去吗？\n',
];

/**
 * 一段真实的 429 报错原文（额度用完时内核即返回该内容，未作任何修改）。
 * 该原文用于构造错误场景：此前这段英文 JSON 会直接展示给用户。
 */
const ERROR_RAW =
  '回合失败：Internal error: turn failed: 429: {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 12min..."}';

const SCENARIOS = {
  /**
   * 刚打开、尚未连接：不应展示任何内容。
   *
   * 该场景针对「CSS 的 hidden 陷阱」：`hidden` 属性会被作者样式中的
   * `display:flex` 覆盖，导致配置行、用量条、权限区持续显示。该场景不发送任何消息，
   * 断言逐条测量上述元素确实不可见。
   */
  bare() {
    return {
      steps: [{ message: { type: 'status', state: 'connecting', detail: '正在连接…' } }],
    };
  },

  /** 空状态：面板刚打开。 */
  empty() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: configMessage },
        { message: presetsMessage },
      ],
    };
  },

  /**
   * 短文案：展示提示文本可以达到的最短长度（2026-09-19 用户第二次提出意见之后）。
   *
   * 单独设置该场景的原因：文案属于不可见的规格，仅记录在文档中会逐渐变长。
   * 此处将自启、复用、重开这三种最常见的提示与一张报错卡片并列展示，
   * 既可用于截图查看，也为「每行 ≤32 字」那条测试提供可对照的样本。
   *
   * 报错卡片使用生产代码 `describeError`（原文折叠在「原始报错（展开）」中）。
   */
  concise() {
    return {
      steps: [
        { message: { type: 'status', state: 'connecting', detail: '正在启动…' } },
        { message: { type: 'notice', text: '正在启动 DSH…' } },
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: configMessage },
        { message: presetsMessage },
        { message: { type: 'notice', text: '继续使用当前正在运行的 DSH。' } },
        { message: { type: 'notice', text: '已按「标准模式」重新开启。' } },
        {
          message: {
            type: 'error',
            message:
              '回合失败：Internal error: turn failed: 429: {"type":"GoUsageLimitError",' +
              '"message":"5-hour usage limit reached. Resets in 12min"}',
            human: describeError(
              '回合失败：Internal error: turn failed: 429: {"type":"GoUsageLimitError",' +
                '"message":"5-hour usage limit reached. Resets in 12min"}',
            ),
          },
        },
      ],
    };
  },

  /**
   * 权限选择器：顶栏的按钮与其展开的小卡片。
   *
   * 单独设置该场景，因为它是唯一一处「清单由内核提供、界面只负责渲染」的控件：
   * 卡片中每一档均带说明、当前档位打勾、最宽的档位还需要经过一道确认环节。
   * 这些操作在无头 Chrome 中可以点击（见 tools/uitest.js 的 access 断言）。
   */
  access() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: configMessage },
        { message: presetsMessage },
        { message: permissionStateMessage },
        // 同时启用用量条：这是配置行最紧凑的一种组合（模型 + 模式 + 权限 + 用量
        // 四项同时存在），宽度分配情况由该组合体现（见 media/main.css 里 #config-row 那段）。
        { message: { type: 'usage', used: 12480, size: 262144 } },
      ],
    };
  },

  /**
   * 压力：一次性注入数百个流式增量，观察耗时与 DOM 是否失控。
   *
   * 单独设置该场景的原因：面板每累积一批增量即重新渲染整段正文的 markdown，
   * 长回答的复杂度为 O(n²) 量级；该复杂度本身可以接受，但若演变为
   * 「每个字符都重新渲染整棵 DOM 树」，界面会出现明显卡顿。此处测量一个上限，用于阻止回归。
   */
  perf() {
    return {
      steps: [
        { message: { type: 'status', state: 'busy', detail: '工作中…' } },
        { message: { type: 'user', text: '写一段长文档给我。' } },
        { message: { type: 'assistant', id: 'a1' } },
        { message: { type: 'busy', busy: true } },
      ],
    };
  },

  /**
   * 带编辑器上下文：挂上「当前文件」与「选中的代码」，然后发送。
   *
   * 这一段验证「附件块」这条链路：挂上后是否可见、点击 × 是否可以移除、
   * 发送时是否携带、发送后是否清空、已发送的那条消息中是否仍能显示
   * 当时携带的内容。
   */
  context() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: configMessage },
        { message: presetsMessage },
        {
          message: {
            type: 'attach',
            items: [
              {
                kind: 'file',
                id: 'src/panel/view.js',
                name: 'src/panel/view.js',
                uri: 'file:///d%3A/dsh-vscode/packages/vscode-extension/src/panel/view.js',
                detail: '当前文件',
              },
              {
                kind: 'selection',
                id: 'src/panel/html.js:80-82',
                name: 'src/panel/html.js',
                uri: 'file:///d%3A/dsh-vscode/packages/vscode-extension/src/panel/html.js',
                text: '<footer class="composer">',
                language: 'html',
                detail: '选中 3 行',
              },
            ],
          },
        },
        {
          message: {
            type: 'user',
            text: '这两个文件是干嘛的？',
            attachments: [
              {
                kind: 'file',
                id: 'src/panel/view.js',
                name: 'src/panel/view.js',
                uri: 'file:///d%3A/dsh-vscode/packages/vscode-extension/src/panel/view.js',
                detail: '当前文件',
              },
              {
                kind: 'selection',
                id: 'src/panel/html.js:80-82',
                name: 'src/panel/html.js',
                uri: 'file:///d%3A/dsh-vscode/packages/vscode-extension/src/panel/html.js',
                text: '<footer class="composer">',
                language: 'html',
                detail: '选中 3 行',
              },
            ],
          },
        },
        { message: { type: 'assistant', id: 'a1' } },
        { message: { type: 'text', id: 'a1', delta: '一个是面板的逻辑，一个是它的结构。' } },
        { message: { type: 'done', id: 'a1', status: 'done' } },
        { message: { type: 'busy', busy: false } },
      ],
    };
  },

  /** 一个完整回合：用户提问 → 思考 → 正文 → 工具卡片 → 结束。 */
  chat() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: configMessage },
        { message: presetsMessage },
        { message: { type: 'usage', used: 12480, size: 262144 } },
        { message: { type: 'user', text: '为什么我的门插件里读 agentPresets 会报错？' } },
        { message: { type: 'assistant', id: 'a1' } },
        {
          message: {
            type: 'thinking',
            id: 'a1',
            delta: '先看看 inject 里声明了什么，再对照 cordis 的服务解析规则……',
          },
        },
        {
          message: {
            type: 'tool',
            id: 'a1',
            tool: {
              toolCallId: 't1',
              kind: 'read',
              status: 'completed',
              title: '读取门插件源码',
              rawInput: { file_path: '<仓库根目录>\\packages\\dsh-door\\lib\\index.js', limit: 40 },
              content: [{ type: 'text', text: "export const inject = ['agents', 'llm', 'sessions'];" }],
            },
          },
        },
        {
          message: {
            type: 'tool',
            id: 'a1',
            tool: {
              toolCallId: 't2',
              kind: 'edit',
              status: 'in_progress',
              title: '补上 agentPresets 依赖',
              rawInput: {
                file_path: 'packages/dsh-door/lib/index.js',
                old_string: "export const inject = ['agents', 'llm', 'sessions'];",
                new_string: "export const inject = ['agents', 'llm', 'sessions', 'agentPresets'];",
              },
            },
          },
        },
        // 正文按块推送，模拟真实流式输出
        ...longAnswer.map((chunk, index) => ({
          message: { type: 'text', id: 'a1', delta: chunk },
          delay: index === 0 ? 60 : 15,
        })),
        { message: { type: 'done', id: 'a1', status: 'done' } },
        { message: { type: 'busy', busy: false } },
        { message: { type: 'usage', used: 14920, size: 262144 } },
      ],
    };
  },

  /** 正在流式输出的中间状态（用于观察光标与布局稳定性）。 */
  streaming() {
    return {
      steps: [
        { message: { type: 'status', state: 'busy', detail: '工作中…' } },
        { message: configMessage },
        { message: { type: 'user', text: '把测试跑一遍，有问题就修。' } },
        { message: { type: 'assistant', id: 'a1' } },
        {
          message: {
            type: 'tool',
            id: 'a1',
            tool: {
              toolCallId: 't1',
              kind: 'execute',
              status: 'in_progress',
              title: '跑集成测试',
              rawInput: { command: 'node test/smoke.js' },
            },
          },
        },
        {
          message: {
            type: 'text',
            id: 'a1',
            delta: '测试在跑，我先把刚才发现的那个问题说清楚：`session/list` 只返回已经落盘的会话',
          },
        },
        { message: { type: 'busy', busy: true } },
      ],
    };
  },

  /**
   * 历史会话：该场景本身只设置「就绪 + 工作目录」，浮层中的清单与回放
   * 均由 uitest 的断言脚本现场注入；原因是真实链路为「点开浮层才请求清单」，
   * 提前传入的消息会被「浮层未打开则不渲染」的防护逻辑丢弃（该防护逻辑是正确的）。
   */
  history() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: { type: 'meta', cwd: '<仓库根目录>\\packages\\vscode-extension' } },
      ],
    };
  },

  /** 权限询问（内核向客户端发起询问）。 */
  permission() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: { type: 'user', text: '删掉 build 目录再重新打包' } },
        { message: { type: 'assistant', id: 'a1' } },
        {
          message: {
            type: 'text',
            id: 'a1',
            delta: '这一步要动文件系统，内核在问你：',
          },
        },
        {
          message: {
            type: 'permission',
            requestId: 7,
            params: {
              toolCall: {
                title: '执行命令：Remove-Item -Recurse build',
                rawInput: { command: 'Remove-Item -Recurse -Force build' },
              },
              options: [
                { optionId: 'allow_once', name: '允许这一次', kind: 'allow_once' },
                { optionId: 'allow_always', name: '以后都允许', kind: 'allow_always' },
                { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
              ],
            },
          },
        },
      ],
    };
  },

  /**
   * 内核报错：界面上应当先给出可读说明，再给出原文。
   *
   * `human` 这一段并非人工编写，而是实际调用 `src/dsh/errors.js` 中的
   * 分类器计算得出；因此该预览页渲染的内容与生产路径向用户展示的内容一致。
   */
  error() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '就绪' } },
        { message: { type: 'user', text: '帮我看看这个报错是怎么回事。' } },
        {
          message: {
            type: 'error',
            message: ERROR_RAW,
            human: describeError(ERROR_RAW),
          },
        },
        { message: { type: 'busy', busy: false } },
      ],
    };
  },
};

// ── 生成 ────────────────────────────────────────────────

/** 将界面逻辑脚本的地址替换为同目录下的相对路径。 */
function buildHtml(themeName) {
  const nonce = makeNonce();
  const html = renderHtml({
    cspSource: "'self'",
    styleUri: 'main.css',
    markdownUri: 'markdown.js',
    scriptUri: 'main.js',
    nonce,
  });

  const themeVars = Object.entries(THEMES[themeName])
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  // 预览专用的注入内容：主题变量与仿真的 acquireVsCodeApi。
  // 必须在 main.js 之前执行，因此插入在其 script 标签之前。
  const prelude = `<style>
:root {
${themeVars}
}
html, body { height: 100%; }
</style>
<script>
window.__received = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (message) { window.__received.push(message); },
    getState: function () { return undefined; },
    setState: function () {},
  };
};
</script>
`;

  // 预览页中需要移除生产环境的 CSP。
  // 生产 HTML 的 CSP 只允许带 nonce 的脚本，而此处插入的「主题变量 + 仿真
  // acquireVsCodeApi + 回放脚本」不带 nonce，会被直接拦截；这一现象
  // 说明生产环境的 CSP 有效。预览不加载任何远程内容，移除该策略不存在风险。
  const withoutCsp = html.replace(
    /<meta http-equiv="Content-Security-Policy"[^>]*>\s*/,
    '<!-- 预览专用：这里故意没有 CSP（见 tools/preview.js 的说明） -->\n',
  );

  return withoutCsp.replace('<script nonce=', `${prelude}<script nonce=`);
}

function buildReplayScript(steps) {
  let at = 120;
  const lines = ['<script>'];
  for (const step of steps) {
    at += step.delay === undefined ? 30 : step.delay;
    if (step.message) {
      lines.push(
        `setTimeout(function () { window.postMessage(${JSON.stringify(step.message)}, '*'); }, ${at});`,
      );
    }
  }
  lines.push('</script>');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const onlyScenario = args[0];
  const onlyTheme = args[1];

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'media', 'main.css'), path.join(OUT, 'main.css'));
  fs.copyFileSync(path.join(ROOT, 'media', 'main.js'), path.join(OUT, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'media', 'markdown.js'), path.join(OUT, 'markdown.js'));

  const written = [];
  for (const [name, factory] of Object.entries(SCENARIOS)) {
    if (onlyScenario && onlyScenario !== name) continue;
    const { steps } = factory();
    for (const themeName of Object.keys(THEMES)) {
      if (onlyTheme && onlyTheme !== themeName) continue;
      let html = buildHtml(themeName);
      // replay 脚本无需置于 main.js 之前：该脚本仅使用 setTimeout，
      // 但必须保证 main.js 已注册监听，因此放在 main.js 之后。
      html = html.replace('</body>', `${buildReplayScript(steps)}\n</body>`);
      const file = path.join(OUT, `${name}-${themeName}.html`);
      fs.writeFileSync(file, html, 'utf8');
      written.push({ file, name, themeName, steps: steps.length });
    }
  }

  console.log(`生成了 ${written.length} 个预览页面：`);
  for (const item of written) {
    console.log(`  ${path.relative(ROOT, item.file)}  （${item.steps} 步）`);
  }
  console.log(`\n输出目录：${OUT}`);
}

if (require.main === module) {
  main();
}

// 供 tools/uitest.js 复用，避免场景定义与主题变量重复维护。
module.exports = { SCENARIOS, THEMES, buildHtml, buildReplayScript, OUT, ROOT };
