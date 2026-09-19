'use strict';

/**
 * 自启内核的集成测试：端口上什么都没有时，扩展要自己把内核拉起来。
 *
 * 这是**最常见的路径**（刚开机、或者用户根本没开桌面端），所以必须单独测：
 * 拉起 → 等到门开 → 握手 → 建会话 → 跑一个真回合 →
 * 收摊时把内核进程真的杀干净（不留孤儿进程占着端口）。
 *
 * 端口：默认 47821（和面板默认一致）。但桌面端开着的时候那个端口上已经有门了，
 * 这个测试就没法做「从零拉起」。所以端口可以用环境变量换：
 *
 *     $env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js
 *
 * 换了端口之后测试会给内核挂一个 `--patch`，把门**钉**到那个端口上
 * （门那一行的 config 是整段替换的，所以 patch 里必须把每个字段都写全）。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

/** 测哪个端口：默认跟面板默认一致，可用 DSH_PANEL_TEST_PORT 换一个空的。 */
const PORT = Number(process.env.DSH_PANEL_TEST_PORT || 47821);

/**
 * 把门钉到 PORT 上的那个 `--patch` 文件。
 *
 * 只在换了端口时才需要：门那一行的 config 是**整段替换**的（实测：
 * 只写 port 的话 host/provider/model/preset 会一起消失），所以这里把
 * 每个字段都照抄一遍。47821 时返回 null —— 档里本来就是那个端口，不用补。
 */
function writeDoorPortPatch() {
  if (PORT === 47821) return null;
  const file = path.join(os.tmpdir(), `dsh-panel-test-door-${PORT}.yml`);
  const body = [
    '# 测试用：把门钉到这个端口上（test/fallback.js 生成，可随时删）。',
    '# 门那一行的 config 是整段替换的，所以每个字段都要写全。',
    '- id: acp-door',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${PORT}`,
    '    provider: opencode-go',
    '    model: deepseek-v4.1-flash',
    '    preset: standard',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const PATCH = writeDoorPortPatch();

const configValues = {
  host: '127.0.0.1',
  port: PORT,
  autoStart: true, // ← 本次测试的主角
  // 生产默认是 desktop（用户自己那一档）。测试里刻意用 dshdoor：
  // 让测试去拉起用户的真实配置，会往他的档和记忆里写东西 —— 测试不该有这个权力。
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
  cwd: SCRATCH,
};

const mockVscode = {
  version: '1.99.0-mock',
  Uri: {
    joinPath: (base, ...parts) => ({
      fsPath: [base.fsPath || String(base), ...parts].join('/'),
      toString: () => [base.fsPath || String(base), ...parts].join('/'),
    }),
    parse: (value) => ({ toString: () => value }),
    file: (value) => ({ fsPath: value, toString: () => value }),
  },
  env: { openExternal: () => Promise.resolve(true) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: SCRATCH } }],
    getConfiguration: () => ({ get: (key) => configValues[key] }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-mock';
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode-mock'] = {
  id: 'vscode-mock',
  filename: 'vscode-mock',
  loaded: true,
  exports: mockVscode,
  children: [],
  paths: [],
};

const { DshPanelView } = require('../src/panel/view');
const { probePort } = require('../src/door/locate');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

function makeFakeView() {
  const messages = [];
  return {
    messages,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://mock',
      asWebviewUri: (uri) => ({ toString: () => `https://webview.local/${uri.toString()}` }),
      onDidReceiveMessage: (callback) => {
        return { dispose() {} };
      },
      postMessage: async (message) => {
        messages.push({ at: Date.now(), message });
        return true;
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

function waitFor(predicate, { totalMs = 200000, intervalMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + totalMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('等待超时'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

(async () => {
  const log = (level, message) => {
    if (level !== 'info') console.log(`     [${level}] ${message}`);
    else if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [info] ${message}`);
  };

  section('0. 前置：端口必须是空的');
  const alreadyUp = await probePort('127.0.0.1', PORT, 800);
  if (alreadyUp) {
    // 这不是失败，是「现在没法测」：这个测试要验证「从零拉起一个内核」，
    // 而这个端口上已经有一个在跑了（比如桌面端 DSH，或者你的 VS Code 正开着）。
    // 用退出码 2 表示跳过，让上层能和真失败区分开。
    console.log(`  ⏭  ${PORT} 上已经有一个 DSH 在跑，这个测试现在没法做。`);
    console.log('     它验证的是「从零拉起」，需要端口空着。两个办法：');
    console.log('     ① 关掉桌面端 DSH（或手工起的试验台）再跑；');
    console.log(`     ② 换个空端口跑：$env:DSH_PANEL_TEST_PORT = '47830'; node test/fallback.js`);
    console.log('     —— 按「跳过」处理，不算失败。');
    process.exit(2);
  }
  console.log(`  ✅ ${PORT} 是空的，可以测自启内核这条路了${PATCH ? `（门钉在 ${PORT}，patch：${PATCH}）` : ''}`);

  section('1. 打开面板 → 应该自己把内核拉起来');
  const panel = new DshPanelView({
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    log,
    // 换了端口时，把门也指过去（生产路径不传这个）。
    spawnArgs: PATCH ? ['--patch', PATCH] : [],
  });
  const view = makeFakeView();
  panel.resolveWebviewView(view);

  const started = Date.now();
  await panel.onWebviewMessage({ type: 'ready' });
  const took = Date.now() - started;

  const statuses = view.messages
    .filter((item) => item.message.type === 'status')
    .map((item) => item.message);
  const notices = view.messages
    .filter((item) => item.message.type === 'notice')
    .map((item) => item.message.text);
  console.log(`     状态序列：${statuses.map((s) => `${s.state}/${s.detail}`).join(' → ')}`);
  console.log(`     对话流提示：${notices.join(' ｜ ') || '（无）'}`);

  check(
    '顶栏说的是短状态（没有把「正在后台启动 DSH（档：…）」塞进顶栏）',
    statuses.every((s) => String(s.detail || '').length <= 24 && !/\n/.test(String(s.detail || ''))),
    JSON.stringify(statuses.map((s) => s.detail)),
  );
  check(
    '「正在启动内核」这件事说在对话流里',
    notices.some((text) => /正在启动一个/.test(text)),
    JSON.stringify(notices),
  );
  check('最终连上了', statuses.some((s) => s.state === 'ready'), JSON.stringify(statuses.at(-1)));
  check('拿到了会话', Boolean(panel.session && panel.session.sessionId), String(panel.session && panel.session.sessionId));
  check('确实是由本扩展拉起的（记着那个后台进程）', Boolean(panel.background), 'panel.background 是空的');
  console.log(`     从零到可用耗时 ${(took / 1000).toFixed(1)}s`);

  section('2. 自己拉起来的连接也能干活');
  const before = view.messages.length;
  await panel.onWebviewMessage({
    type: 'send',
    text: '用一句话回答：你现在连的是哪个模型？不要用工具。',
  });
  const after = view.messages.slice(before).map((item) => item.message);
  check('收到正文', after.some((item) => item.type === 'text' && item.delta), JSON.stringify(after.map((i) => i.type)));
  check('回合正常结束', after.some((item) => item.type === 'done'));
  check('没有错误', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  section('3. 自己拉起来的那个内核要能复用，不能每连一次就多起一个');
  {
    // 目标里写的是"内核由插件自己按需拉起**并可复用**"。复用有两种：
    //   ① 桌面端已经开着 → 直接接它的（vscode-check 的接入模式那 11 项验的就是这条）；
    //   ② 自己拉起来的那个还在跑 → 断线重连时**接着用它**，别再拉一个。
    // ② 以前没有测试盯着，而它最容易坏的地方是「重连时又 spawn 一个」——
    // 那种 bug 在界面上看不出来（照样能用），只会在进程列表里越堆越多。
    const pidBefore = panel.background && panel.background.child && panel.background.child.pid;
    const backgroundBefore = panel.background;

    // 掐断客户端连接，等价于内核那边网络抖了一下 / DSH 重启了。
    panel.client.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    check('断线后会话被放掉了（下次发送会重连）', !panel.session, String(panel.session));
    check('断线不会把自启的那个内核收掉（留着复用）', Boolean(panel.background), 'background 没了');

    const resumeIndex = view.messages.length;
    await panel.onWebviewMessage({ type: 'send', text: '断线重连之后，回一句话确认你还活着。' });
    const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);

    const pidAfter = panel.background && panel.background.child && panel.background.child.pid;
    check('重连时复用了同一个内核（没有另起一个）',
      pidBefore === pidAfter && panel.background === backgroundBefore,
      `pid ${pidBefore} → ${pidAfter}`);
    check('重连后照样能干活', resumeMessages.some((item) => item.type === 'done'),
      JSON.stringify(resumeMessages.map((i) => i.type)));
    check('重连过程没有报错', !resumeMessages.some((item) => item.type === 'error'),
      JSON.stringify(resumeMessages.filter((i) => i.type === 'error').map((i) => i.message)));
  }

  section('4. 收摊必须杀干净（Windows 上最容易漏）');
  const childPid = panel.background && panel.background.child && panel.background.child.pid;
  console.log(`     后台 DSH 的 pid：${childPid}`);
  panel.dispose();

  let portFreed = false;
  try {
    await waitFor(async () => !(await probePort('127.0.0.1', PORT, 400)), {
      totalMs: 30000,
      intervalMs: 600,
    });
    portFreed = true;
  } catch {
    portFreed = false;
  }
  check('端口被释放了（后台 DSH 真的被杀了）', portFreed, portFreed ? '' : '30s 内端口还占着，可能留了孤儿进程');

  if (childPid) {
    const { execFileSync } = require('node:child_process');
    let stillThere = false;
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${childPid}`, '/NH'], { encoding: 'utf8' });
      stillThere = out.includes(String(childPid));
    } catch {
      stillThere = false;
    }
    check('进程树上没有残留的 dsh 进程', !stillThere, `pid ${childPid} 还在`);
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('💥 测试崩了：', error.stack || error.message);
  process.exit(1);
});
