'use strict';

/**
 * 界面预览器：把 webview 的 HTML/CSS/JS 拿到真浏览器里渲染，方便截图检查。
 *
 * 为什么需要它：面板跑在 VS Code 的 webview 里，没有自动化手段能可靠地
 * 点开它、截图。但界面层只有三样东西：一份 HTML 骨架、一份 CSS、一份 JS。
 * 把这三样塞进无头 Chrome，就能**真的看到**界面长什么样 —— 而不是靠想象。
 *
 * 关键细节：HTML 骨架直接用 src/panel/html.js 里那个**生产用的**函数生成，
 * 所以预览不会和真实界面脱节（改了 html.js，预览立刻跟着变）。
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

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'preview');

/**
 * 主题变量。
 *
 * 注意：这里只是**预览用的近似值**（取自 VS Code 默认主题的公开色值），
 * 真正的面板里一个硬编码颜色都没有，全部靠 VS Code 注入的变量。
 * 这份表的作用是让我在没有编辑器的情况下也能看见真实观感。
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

// ── 场景：每一步要么「发一条消息给界面」，要么只是「等一会儿」 ──────────

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
 * 门在 session/new 回复里补的那份预设清单（真实形状，对着 dsh-acp-door 抄的）。
 * 界面上的「模式」下拉就是拿它渲染的。
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

const SCENARIOS = {
  /**
   * 刚打开、还没连上：什么都不该露出来。
   *
   * 这个场景是专门为「CSS 的 hidden 陷阱」写的：`hidden` 属性会被作者样式里的
   * `display:flex` 盖掉，于是配置行、用量条、权限区会一直挂在那儿。这里什么都不发，
   * 断言里逐条量它们「真的看不见」。
   */
  bare() {
    return {
      steps: [{ message: { type: 'status', state: 'connecting', detail: '连接 127.0.0.1:47821…' } }],
    };
  },

  /** 空状态：刚打开面板。 */
  empty() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '已连上正在运行的 DSH' } },
        { message: configMessage },
        { message: presetsMessage },
      ],
    };
  },

  /**
   * 带编辑器上下文：挂上"当前文件"和"选中的代码"，然后发出去。
   *
   * 这一段测的是「附件块」这条链路：挂上去看得见吗、点 × 拿得掉吗、
   * 发出去的时候带上了吗、发完清空了吗、"已经被发出去的那条消息"里还看不看得出
   * 它当时带了什么。
   */
  context() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '已连上正在运行的 DSH' } },
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
        { message: { type: 'status', state: 'ready', detail: '已连上正在运行的 DSH' } },
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
              rawInput: { file_path: 'D:\\dsh-vscode\\packages\\dsh-door\\lib\\index.js', limit: 40 },
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
        // 正文按块推，模拟真实流式
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

  /** 正在流式输出的中间态（看光标、看布局稳不稳）。 */
  streaming() {
    return {
      steps: [
        { message: { type: 'status', state: 'busy', detail: 'DSH 正在工作…' } },
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

  /** 权限询问（内核反过来问客户端）。 */
  permission() {
    return {
      steps: [
        { message: { type: 'status', state: 'ready', detail: '已连上正在运行的 DSH' } },
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
};

// ── 生成 ────────────────────────────────────────────────

/** 把界面逻辑脚本的地址换成同目录下的相对路径。 */
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

  // 预览专用的注入：主题变量 + 假的 acquireVsCodeApi。
  // 必须在 main.js 之前执行，所以插在它的 script 标签前面。
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

  // 预览页里要把生产 CSP 摘掉。
  // 生产 HTML 的 CSP 只允许带 nonce 的脚本，而我插进去的「主题变量 + 假
  // acquireVsCodeApi + 回放脚本」是不带 nonce 的，会被直接拦掉 —— 这恰恰
  // 说明生产环境的 CSP 是有效的。预览不加载任何远程内容，摘掉没有风险。
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
      // replay 脚本也要放 main.js 之前？不用 —— 它只用 setTimeout，
      // 但必须保证 main.js 已经注册好监听，所以放到 main.js 之后。
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

// 给 tools/uitest.js 复用，免得场景定义和主题变量写两份。
module.exports = { SCENARIOS, THEMES, buildHtml, buildReplayScript, OUT, ROOT };
