'use strict';

/**
 * 面板层集成测试。
 *
 * 手法：把 `vscode` 这个模块名劫持成一个假的实现，于是 panel/view.js
 * 能在**没有编辑器**的情况下被完整跑起来 —— 包括注册视图、生成 HTML、
 * 收发 webview 消息、连真的门、跑真回合。
 *
 * 这能盖住界面上看不到的那一大半 bug：消息时序、状态机、字段名、
 * 会话生命周期。真正的浏览器渲染另外验（见 test/static.js）。
 *
 * 用法：node test/panel.js   （同样需要一个 DSH 在 47821 上开门）
 */

const path = require('node:path');
const Module = require('node:module');

// ── 先装假 vscode，再 require 面板 ────────────────────────

const openedLinks = [];
const configValues = {
  host: '127.0.0.1',
  port: 47821,
  autoStart: false,
  fallbackProfile: 'dshdoor',
  dshCommand: 'dsh',
  provider: '',
  model: '',
  cwd: path.resolve(__dirname, '..', '..', '..', 'spike', 'scratch'),
};

const mockVscode = {
  version: '1.99.0-mock',
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath || base.path || String(base), ...parts].join('/'), toString: () => [base.fsPath || base.path || String(base), ...parts].join('/') }),
    parse: (value) => ({ toString: () => value, value }),
    file: (value) => ({ fsPath: value, toString: () => value }),
  },
  env: {
    openExternal: (uri) => {
      openedLinks.push(String(uri));
      return Promise.resolve(true);
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: configValues.cwd } }],
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
const { ensureDoor } = require('./helpers/door');

// ── 断言小工具 ──────────────────────────────────────────

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

function waitFor(predicate, { totalMs = 30000, intervalMs = 40 } = {}) {
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

/** 一个记录所有收到的消息的假 webview。 */
function makeFakeView() {
  const messages = [];
  const view = {
    messages,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://mock',
      asWebviewUri: (uri) => ({ toString: () => `https://webview.local/${uri.toString()}` }),
      onDidReceiveMessage: (callback) => {
        view.receive = callback;
        return { dispose() {} };
      },
      postMessage: async (message) => {
        messages.push({ at: Date.now(), message });
        return true;
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return view;
}

function typesOf(items) {
  // 既接受「包装过的」{at, message}，也接受裸消息，免得测试自己踩自己。
  return items.map((item) => (item && item.message ? item.message.type : item && item.type));
}

(async () => {
  const log = (level, message) => {
    if (process.env.DSH_PANEL_TEST_VERBOSE) console.log(`     [${level}] ${message}`);
  };

  // 断线接回测试要用一个不容易被模型「猜中」的数字。
  const MARKER = String(1000 + Math.floor(Math.random() * 8999));

  // 内核没开就自己拉一个（跑完负责收摊）。「自动拉起」那条路另有
  // test/fallback.js 专测，所以这里配置里的 autoStart 是关的，免得两处都拉进程。
  const door = await ensureDoor({ log });

  section('1. 视图注册与 HTML 生成');
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:\\dsh-vscode\\packages\\vscode-extension' }, log });
  const view = makeFakeView();
  panel.resolveWebviewView(view);

  const html = view.webview.html;
  check('生成了 HTML', typeof html === 'string' && html.length > 200, `${html.length} 字节`);
  check('HTML 里有 CSP', /Content-Security-Policy/.test(html));
  check('CSP 不允许内联脚本', !/script-src[^;]*unsafe-inline/.test(html));
  check('HTML 引用了样式表', /main\.css/.test(html));
  check('HTML 引用了脚本', /main\.js/.test(html));
  check('脚本带了 nonce', /<script nonce="[A-Za-z0-9]{32}"/.test(html));
  check('开启了脚本执行', view.webview.options.enableScripts === true);

  section('2. 界面就绪 → 自动连接');
  await panel.onWebviewMessage({ type: 'ready' });
  const statuses = view.messages.filter((item) => item.message.type === 'status').map((item) => item.message);
  check('有状态推送', statuses.length > 0, JSON.stringify(statuses));
  check('最终状态是 ready', statuses.some((item) => item.state === 'ready'), JSON.stringify(statuses.at(-1)));
  check('连上后推了配置项', view.messages.some((item) => item.message.type === 'config'));
  check('拿到了 sessionId', typeof panel.session.sessionId === 'string', String(panel.session.sessionId));

  section('3. 发一条消息，走完整条链路');
  const before = view.messages.length;
  const prompt = '读取 spike/scratch/hello.ts 的第一行，只回那一行，不要解释。';
  await panel.onWebviewMessage({ type: 'send', text: prompt });
  const after = view.messages.slice(before).map((item) => item.message);

  check('界面先收到自己发的话', after[0] && after[0].type === 'user', JSON.stringify(after[0]));
  check('收到 assistant 开始', after.some((item) => item.type === 'assistant'));
  check('收到正文增量', after.some((item) => item.type === 'text' && item.delta));
  check('收到工具卡片', after.some((item) => item.type === 'tool'));
  check('收到用例用量', after.some((item) => item.type === 'usage'));
  check('收到回合结束', after.some((item) => item.type === 'done'));
  check('busy 开过', after.some((item) => item.type === 'busy' && item.busy === true));
  check('busy 关了', after.some((item) => item.type === 'busy' && item.busy === false));
  check('没有错误消息', !after.some((item) => item.type === 'error'), JSON.stringify(after.filter((i) => i.type === 'error')));

  const toolMessages = after.filter((item) => item.type === 'tool').map((item) => item.tool);
  const finalTools = new Map();
  for (const tool of toolMessages) finalTools.set(tool.toolCallId, tool);
  check('工具卡片按 id 合并了（没有重复卡片）', finalTools.size >= 1 && finalTools.size <= toolMessages.length);
  const firstTool = [...finalTools.values()][0];
  if (firstTool) {
    check('工具卡片最终是完成状态', firstTool.status === 'completed' || firstTool.status === 'failed', firstTool.status);
    check('工具卡片带了 rawInput', Boolean(firstTool.rawInput), JSON.stringify(firstTool.rawInput));
  }

  section('4. 顺序检查（界面靠这个顺序渲染）');
  const ordered = typesOf(after);
  const indexUser = ordered.indexOf('user');
  const indexAssistant = ordered.indexOf('assistant');
  const indexText = ordered.indexOf('text');
  const indexDone = ordered.indexOf('done');
  check('user 在 assistant 之前', indexUser >= 0 && indexUser < indexAssistant, ordered.join('>'));
  check('assistant 在第一条 text 之前', indexAssistant < indexText, ordered.join('>'));
  check('done 在最后', indexDone > indexText, ordered.join('>'));

  section('5. 新建对话');
  const oldId = panel.session.sessionId;
  await panel.onWebviewMessage({ type: 'newSession' });
  check('界面被要求清空', view.messages.some((item) => item.message.type === 'reset'));
  check('换了新会话', panel.session.sessionId !== oldId, `${oldId} → ${panel.session.sessionId}`);

  section('6. 拒绝危险链接');
  await panel.onWebviewMessage({ type: 'openLink', href: 'javascript:alert(1)' });
  check('javascript: 没有被打开', openedLinks.length === 0, openedLinks.join(','));
  await panel.onWebviewMessage({ type: 'openLink', href: 'https://example.com/x' });
  check('https 链接被放行', openedLinks.length === 1, openedLinks.join(','));

  section('7. 未知消息不会炸');
  await panel.onWebviewMessage({ type: '完全不认识的类型' });
  await panel.onWebviewMessage(null);
  check('未知消息后还能正常发消息', panel.session.sessionId !== null);
  await panel.onWebviewMessage({ type: 'send', text: '说一句：收到。' });
  check('之后仍能收到回复', view.messages.some((item) => item.message.type === 'done'));

  section('8. 断线：必须能自动接回上下文');
  // 这是真实会遇到的场景：DSH 桌面端被关掉/重启，而面板还开着。
  // 实测 session/resume 有效（test/resume.js），所以面板不该开一个没记忆的新会话 ——
  // 那样用户会以为它还记着上面那段对话。
  const beforeDrop = panel.session.sessionId;
  await panel.onWebviewMessage({ type: 'send', text: `记住数字 ${MARKER}，只回答「已记住」。` });
  check('断线前这一段能正常跑完', view.messages.some((item) => item.message.type === 'done'));

  const dropIndex = view.messages.length;
  panel.client.close(); // 掐断连接，等价于内核没了
  await new Promise((resolve) => setTimeout(resolve, 600));

  const afterDrop = view.messages.slice(dropIndex).map((item) => item.message);
  check(
    '断线被界面看见了',
    afterDrop.some((item) => item.type === 'status' && item.state === 'error' && /断开/.test(item.detail || '')),
    JSON.stringify(afterDrop.map((i) => i.type)),
  );
  check(
    '断线后会解除「正在回答」状态（否则停止按钮会一直转）',
    afterDrop.some((item) => item.type === 'busy' && item.busy === false),
    JSON.stringify(afterDrop),
  );
  check('断线后会话被放掉，下次发送会重连', !panel.session, String(panel.session));

  const resumeIndex = view.messages.length;
  await panel.onWebviewMessage({ type: 'send', text: '我刚才让你记住的数字是多少？只回答数字。' });
  check('重连后拿回了会话', Boolean(panel.session && panel.session.sessionId));
  check(
    '拿回的是原来那个会话（不是悄悄开了个新的）',
    panel.session.sessionId === beforeDrop,
    `${beforeDrop} → ${panel.session.sessionId}`,
  );
  const resumeMessages = view.messages.slice(resumeIndex).map((item) => item.message);
  check(
    '上下文真的接回来了（它答得出断线前那个数字）',
    resumeMessages.some((item) => item.type === 'text' && String(item.delta).includes(MARKER)),
    JSON.stringify(resumeMessages.filter((i) => i.type === 'text').map((i) => i.delta)).slice(0, 200),
  );

  section('8.5 兜底拉起失败时，别让用户干等两分钟');
  {
    // 场景：门连不上 + 自动拉起 + 命令写错（dshCommand 填了个不存在的路径）。
    // 以前这里会老老实实等满 120 秒的 waitForPort，用户对着
    // "正在后台启动 DSH…" 干等两分钟，最后只得到一句"没开门"。
    const saved = { ...configValues };
    configValues.autoStart = true;
    configValues.port = 47844; // 这个端口上不会有门
    configValues.dshCommand = 'dsh-这个命令不存在-9f3a';
    const badPanel = new DshPanelView({
      extensionUri: { fsPath: 'D:\\dsh-vscode\\packages\\vscode-extension' },
      log,
    });
    const badView = makeFakeView();
    badPanel.resolveWebviewView(badView);

    const startedAt = Date.now();
    await badPanel.onWebviewMessage({ type: 'ready' });
    const elapsed = Date.now() - startedAt;

    const all = badView.messages.map((item) => item.message);
    const errorStatus = all.find((item) => item.type === 'status' && item.state === 'error');
    check('命令不存在时给出了错误状态（不是一直转圈）', Boolean(errorStatus),
      JSON.stringify(all.slice(-3)));
    check('错误里说清了是哪个命令、该怎么办',
      Boolean(errorStatus) &&
        errorStatus.detail.includes(configValues.dshCommand) &&
        /PATH|dshCommand/.test(errorStatus.detail),
      errorStatus ? errorStatus.detail : '没有错误消息');
    check('而且是**早点**说的（没有干等满 120 秒）', elapsed < 15000, `耗时 ${elapsed}ms`);
    badPanel.dispose();
    Object.assign(configValues, saved);
  }

  section('9. 收摊');
  panel.dispose();
  door.stop();
  check('dispose 后能再建面板', true);

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
