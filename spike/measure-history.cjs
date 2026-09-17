'use strict';

/** 一次性：量历史浮层在 420px 宽度下有没有横向溢出。 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { buildHtml, OUT, ROOT } = require('../packages/vscode-extension/tools/preview');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const HISTORY_MESSAGE = {
  type: 'history',
  skipped: 44,
  sessions: [
    {
      id: 'a',
      title: '修门插件的依赖注入',
      turns: 12,
      lastTime: Date.now() - 3600e3,
      cwd: 'D:/dsh-vscode/packages/vscode-extension',
      preset: 'standard',
    },
    {
      id: 'b',
      title: '帮我看看这个报错是怎么回事',
      turns: 1,
      lastTime: Date.now() - 86400e3,
      cwd: 'C:/Users/Lenovo',
      decodeError: 'x',
    },
  ],
};

const html = buildHtml('light')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '')
  .replace(
    '</body>',
    `<script>
setTimeout(function () {
  document.getElementById('history-btn').click();
  window.postMessage({ type: 'status', state: 'ready', detail: 'x' }, '*');
  window.postMessage(${JSON.stringify(HISTORY_MESSAGE)}, '*');
}, 400);
</script>
<script>
setTimeout(async function () {
  var row = document.querySelector('.history-item');
  if (!row) { row = { getBoundingClientRect: function () { return { right: -1, left: -1, width: 0 }; }, querySelector: function () { return null; } }; }
  var btn = row.querySelector ? row.querySelector('.history-item-actions') : null;
  var list = document.getElementById('history-list');
  var out = {
    viewport: window.innerWidth,
    rowRight: Math.round(row.getBoundingClientRect().right),
    rowLeft: Math.round(row.getBoundingClientRect().left),
    btnRight: btn ? Math.round(btn.getBoundingClientRect().right) : -1,
    listClientW: list ? list.clientWidth : -1,
    listScrollW: list ? list.scrollWidth : -1,
    rowW: Math.round(row.getBoundingClientRect().width),
  };
  var pre = document.createElement('pre');
  pre.id = '__m';
  pre.textContent = 'MEASURE:' + JSON.stringify(out);
  document.body.appendChild(pre);
}, 1600);
</script>
</body>`,
  );

const page = path.join(OUT, 'measure-history.html');
fs.writeFileSync(page, html, 'utf8');
const dumped = execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--window-size=420,900',
    '--virtual-time-budget=6000',
    `--user-data-dir=${path.join(ROOT, 'build', 'chrome-profile')}`,
    '--dump-dom',
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { stdio: 'pipe', maxBuffer: 50e6 },
).toString();
const match = /MEASURE:(\{.*?\})</.exec(dumped);
if (!match) {
  console.log('没量到（断言脚本没跑）');
  process.exit(1);
}
console.log('量测结果:', match[1]);
