'use strict';

/**
 * 兜底路径的集成测试：桌面端没在跑时，扩展要自己把后台 DSH 拉起来。
 *
 * 这是**用户明早最可能走的路径**（刚开机，桌面端 DSH 还没启动），所以
 * 必须单独测：拉起 → 等到门开 → 握手 → 建会话 → 跑一个真回合 →
 * 收摊时把后台进程真的杀干净（不留孤儿进程占着端口）。
 *
 * 前置：47821 端口必须是**空的**。跑之前请先停掉手动启动的试验台。
 * 用法：node test/fallback.js
 */

const path = require('node:path');
const Module = require('node:module');

const SCRATCH = path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch');

const configValues = {
  host: '127.0.0.1',
  port: 47821,
  autoStart: true, // ← 本次测试的主角
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
  const alreadyUp = await probePort('127.0.0.1', 47821, 800);
  if (alreadyUp) {
    console.log('  ❌ 47821 上已经有 DSH 在跑 —— 这个测试需要它空着。');
    console.log('     请先停掉手动启动的试验台，再跑这个测试。');
    process.exit(1);
  }
  console.log('  ✅ 47821 是空的，可以测兜底路径了');

  section('1. 打开面板 → 应该自动拉起后台 DSH');
  const panel = new DshPanelView({
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    log,
  });
  const view = makeFakeView();
  panel.resolveWebviewView(view);

  const started = Date.now();
  await panel.onWebviewMessage({ type: 'ready' });
  const took = Date.now() - started;

  const statuses = view.messages
    .filter((item) => item.message.type === 'status')
    .map((item) => item.message);
  console.log(`     状态序列：${statuses.map((s) => `${s.state}/${s.detail}`).join(' → ')}`);

  check('确实发了「正在后台启动」的状态', statuses.some((s) => /后台启动/.test(s.detail || '')), JSON.stringify(statuses));
  check('最终连上了', statuses.some((s) => s.state === 'ready'), JSON.stringify(statuses.at(-1)));
  check('拿到了会话', Boolean(panel.session && panel.session.sessionId), String(panel.session && panel.session.sessionId));
  check('确实是由本扩展拉起的（记着那个后台进程）', Boolean(panel.background), 'panel.background 是空的');
  console.log(`     从零到可用耗时 ${(took / 1000).toFixed(1)}s`);

  section('2. 兜底连接也能干活');
  const before = view.messages.length;
  await panel.onWebviewMessage({
    type: 'send',
    text: '用一句话回答：你现在连的是哪个模型？不要用工具。',
  });
  const after = view.messages.slice(before).map((item) => item.message);
  check('收到正文', after.some((item) => item.type === 'text' && item.delta), JSON.stringify(after.map((i) => i.type)));
  check('回合正常结束', after.some((item) => item.type === 'done'));
  check('没有错误', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  section('3. 收摊必须杀干净（Windows 上最容易漏）');
  const childPid = panel.background && panel.background.child && panel.background.child.pid;
  console.log(`     后台 DSH 的 pid：${childPid}`);
  panel.dispose();

  let portFreed = false;
  try {
    await waitFor(async () => !(await probePort('127.0.0.1', 47821, 400)), {
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
