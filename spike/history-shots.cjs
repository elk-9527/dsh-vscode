'use strict';

/**
 * 一次性：给「历史会话」浮层拍预览图。
 *
 * 为什么不进 shots.js：shots.js 只会按时序回放消息，而历史清单有「浮层没开
 * 就不渲染」的护栏（这条护栏是对的），所以浮层内容必须「点开按钮之后再喂」
 * —— 这里用一段专用脚本模拟：点按钮 → 喂清单 / 喂回放。
 *
 * 用法：node spike/history-shots.js
 * 输出：packages/vscode-extension/shots/history-{light,dark}.png
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildHtml, OUT, ROOT } = require('../packages/vscode-extension/tools/preview');

const SHOTS = path.join(ROOT, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 跟门 0.0.8 真实应答同形状的样例清单。 */
const HISTORY_MESSAGE = {
  type: 'history',
  skipped: 44,
  sessions: [
    {
      id: 'session-alpha',
      title: '修门插件的依赖注入',
      turns: 12,
      lastTime: Date.now() - 3600e3,
      cwd: 'D:/dsh-vscode/packages/vscode-extension',
      preset: 'standard',
    },
    {
      id: 'session-beta',
      title: '给面板加历史会话列表',
      turns: 4,
      lastTime: Date.now() - 86400e3,
      cwd: 'D:/dsh-vscode/packages/vscode-extension',
      preset: 'ptc',
    },
    {
      id: 'session-gamma',
      title: '重写界面的渲染循环',
      turns: 21,
      lastTime: Date.now() - 3 * 86400e3,
      cwd: 'D:/dsh-vscode/packages/dsh-door',
      preset: 'standard',
    },
    {
      id: 'session-delta',
      title: '',
      fallbackTitle: '帮我看看这个报错是怎么回事',
      turns: 1,
      lastTime: Date.parse('2026-09-01T09:12:00'),
      cwd: 'C:/Users/Lenovo',
      decodeError: '有一帧解码失败',
    },
  ],
};

const REPLAY_MESSAGE = {
  type: 'replay',
  truncated: false,
  card: { id: 'session-alpha', title: '修门插件的依赖注入', turns: 12, lastTime: Date.now() - 3600e3 },
  entries: [
    { kind: 'user', text: '门插件里读 agentPresets 为什么报 cannot get property？' },
    {
      kind: 'assistant',
      text: '原因是 cordis 不允许在没有声明 **inject** 的情况下读服务属性：\n\n```js\n// ❌ 直接读会抛\nctx.on(\'agent/created\', ({ agent }) => ctx.agentPresets.mount(agent, \'standard\'));\n```\n\n要点有两个：\n\n1. 必须声明 `inject`，cordis 没有「可选依赖」；\n2. 挂预设是异步的，第一个 prompt 可能比它先到，入站要压一下。',
      thinking: '先查 cordis 的服务解析规则，再对照内核的报错原文……',
    },
    {
      kind: 'tool',
      name: 'read',
      args: { file_path: 'packages/dsh-door/lib/index.js' },
      output: "export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions', 'agentPresets'];",
    },
    { kind: 'assistant', text: '补上 `inject` 就好了。要我直接把改动写进去吗？' },
  ],
};

function page(theme, kind) {
  const html = buildHtml(theme);
  const script = `
<script>
setTimeout(function () {
  document.getElementById('history-btn').click();
  window.postMessage(${JSON.stringify(kind === 'list' ? HISTORY_MESSAGE : { type: 'history', skipped: 0, sessions: [] })}, '*');
  window.postMessage({ type: 'status', state: 'ready', detail: '已连上正在运行的 DSH' }, '*');
}, 500);
${
  kind === 'replay'
    ? `setTimeout(function () {
  window.postMessage(${JSON.stringify(REPLAY_MESSAGE)}, '*');
}, 1100);`
    : ''
}
</script>
`;
  const base = html.replace('<meta http-equiv="Content-Security-Policy"[^>]*>', '');
  const noCsp = base.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
  return noCsp.replace('</body>', `${script}\n</body>`);
}

function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const kind of ['list', 'replay']) {
      const file = path.join(OUT, `history-${kind}-${theme}.html`);
      fs.writeFileSync(file, page(theme, kind), 'utf8');
      const png = path.join(SHOTS, `history-${kind}-${theme}.png`);
      const result = spawnSync(
        CHROME,
        [
          '--headless=new', '--disable-gpu', '--hide-scrollbars',
          '--no-first-run', '--no-default-browser-check',
          '--force-device-scale-factor=1', '--window-size=420,900',
          '--virtual-time-budget=6000',
          `--screenshot=${png}`,
          `--user-data-dir=${path.join(ROOT, 'vscode-extension', 'build', 'chrome-profile')}`,
          `file:///${file.replace(/\\/g, '/')}`,
        ],
        { stdio: 'pipe' },
      );
      if (result.status !== 0) {
        console.error(`截图失败 ${png}:`, result.stderr && result.stderr.toString().slice(0, 200));
        process.exit(1);
      }
      console.log('已生成', path.relative(ROOT, png));
    }
  }
}

main();
