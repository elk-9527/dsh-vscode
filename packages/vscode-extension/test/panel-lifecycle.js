'use strict';

/** 面板视图销毁、主动断开与异常断开的纯生命周期回归测试。 */

const Module = require('node:module');
const { EventEmitter } = require('node:events');

const config = {
  host: '127.0.0.1',
  port: 47821,
  selfStartPort: 47831,
  autoStart: true,
  fallbackProfile: 'vscode-panel',
  dshCommand: 'dsh',
  kernelIdleMinutes: 10,
};

const mockVscode = {
  Uri: {
    joinPath: (base, ...parts) => ({ toString: () => [base.fsPath || '', ...parts].join('/') }),
    parse: (value) => ({ toString: () => value }),
  },
  env: { openExternal: async () => true },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (key) => config[key], inspect: () => undefined }),
  },
  commands: { executeCommand: async () => undefined },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-lifecycle-mock';
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode-lifecycle-mock'] = {
  id: 'vscode-lifecycle-mock',
  filename: 'vscode-lifecycle-mock',
  loaded: true,
  exports: mockVscode,
  children: [],
  paths: [],
};

const { DshPanelView } = require('../src/panel/view');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────`);
}

function fakeView() {
  const view = {
    webview: {
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => ({ toString: () => uri.toString() }),
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async () => true,
    },
    onDidDispose(callback) {
      view.disposeView = callback;
      return { dispose() {} };
    },
  };
  return view;
}

function fakeKernels() {
  const background = { id: 'owned' };
  const entry = { background };
  return {
    background,
    released: 0,
    acquired: 0,
    setIdleMs() {},
    release() { this.released += 1; },
    acquire(_consumer, value) { if (value === entry) this.acquired += 1; },
    live() { return entry; },
  };
}

function fakeSession(id = 's-1') {
  const session = new EventEmitter();
  session.sessionId = id;
  session.disposed = 0;
  session.stopped = 0;
  session.answers = [];
  session.dispose = () => { session.disposed += 1; };
  session.stop = () => { session.stopped += 1; };
  session.answerPermission = (requestId, optionId) => {
    session.answers.push({ requestId, optionId });
  };
  return session;
}

function fakeClient() {
  const client = new EventEmitter();
  client.close = () => client.emit('close', '客户端主动断开');
  return client;
}

console.log('DSH Panel · 面板生命周期');

section('1. 视图销毁释放引用；宽限期内重开重新取得引用');
{
  const kernels = fakeKernels();
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels });
  panel.background = kernels.background;
  const first = fakeView();
  panel.resolveWebviewView(first);
  const acquiredBeforeDispose = kernels.acquired;
  first.disposeView();
  check('视图销毁后释放后台内核引用', kernels.released === 1, String(kernels.released));
  check('销毁的视图已从面板移除', panel.view === undefined);

  const second = fakeView();
  panel.resolveWebviewView(second);
  check(
    '重新打开后重新取得同一内核引用',
    kernels.acquired === acquiredBeforeDispose + 1,
    `${acquiredBeforeDispose} → ${kernels.acquired}`,
  );
}

section('2. 主动 teardown 不得显示断线错误或安排错误恢复');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('intentional');
  const client = fakeClient();
  const posted = [];
  panel.post = (message) => posted.push(message);
  panel.session = session;
  panel.client = client;
  panel.wire(session, client);
  panel.teardown();
  check('主动关闭没有错误卡片', posted.filter((item) => item.type === 'error').length === 0, JSON.stringify(posted));
  check('主动关闭没有设置 resumeTarget', panel.resumeTarget === undefined, String(panel.resumeTarget));
  check('会话监听已清理', session.disposed === 1, String(session.disposed));
}

section('3. 异常断开只显示一次，并记录恢复目标');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('unexpected');
  const client = fakeClient();
  const posted = [];
  panel.post = (message) => posted.push(message);
  panel.session = session;
  panel.client = client;
  panel.wire(session, client);
  client.emit('close', 'read ECONNRESET');
  const errors = posted.filter((item) => item.type === 'error');
  check('异常断开只显示一张错误卡片', errors.length === 1, JSON.stringify(errors));
  check('异常断开记录原会话用于恢复', panel.resumeTarget === 'unexpected', String(panel.resumeTarget));
  check('关闭后的会话与客户端引用已清空', panel.session === undefined && panel.client === undefined);
  check('异常断开同样清理会话监听', session.disposed === 1, String(session.disposed));
}

section('4. 面板关闭时取消无人能够回答的权限请求');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const view = fakeView();
  const session = fakeSession('permission-wait');
  const client = fakeClient();
  const posted = [];
  panel.post = (message) => posted.push(message);
  panel.resolveWebviewView(view);
  panel.session = session;
  panel.client = client;
  panel.wire(session, client);

  client.emit('permission', 41, { toolCall: { title: '需要确认' }, options: [] });
  check(
    '视图存在时把权限问题交给界面',
    posted.some((item) => item.type === 'permission' && item.requestId === 41),
    JSON.stringify(posted),
  );
  check('等待作答的请求被记录', panel.pendingPermissionRequests.size === 1);

  view.disposeView();
  check(
    '视图销毁时主动回答取消（内核不会永久等待）',
    session.answers.some((item) => item.requestId === 41 && item.optionId === undefined),
    JSON.stringify(session.answers),
  );
  check('取消后不保留过期请求', panel.pendingPermissionRequests.size === 0);

  client.emit('permission', 42, { toolCall: { title: '视图已不存在' }, options: [] });
  check(
    '视图已经不存在时新权限请求立即取消',
    session.answers.some((item) => item.requestId === 42 && item.optionId === undefined),
    JSON.stringify(session.answers),
  );
  check('未知请求 id 不会被误写回连接', panel.answerPendingPermission(999, 'allow') === false);
}

section('5. 多个权限请求依次显示；停止回合会取消并清空弹窗');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('permission-queue');
  const client = fakeClient();
  const posted = [];
  panel.post = (message) => posted.push(message);
  panel.view = fakeView();
  panel.session = session;
  panel.client = client;
  panel.wire(session, client);

  client.emit('permission', 51, { toolCall: { title: '第一项' }, options: [{ optionId: 'once' }] });
  client.emit('permission', 52, { toolCall: { title: '第二项' }, options: [{ optionId: 'once' }] });
  const shownBeforeAnswer = posted.filter((item) => item.type === 'permission');
  check(
    '并发到达时只显示第一项（第二项不会覆盖它）',
    shownBeforeAnswer.length === 1 && shownBeforeAnswer[0].requestId === 51,
    JSON.stringify(shownBeforeAnswer),
  );
  check('两个请求都进入等待队列', panel.pendingPermissionRequests.size === 2);
  check('尚未显示的请求不能被过期界面提前回答', panel.answerPendingPermission(52, 'once') === false);

  check('回答当前请求成功', panel.answerPendingPermission(51, 'once') === true);
  const shownAfterAnswer = posted.filter((item) => item.type === 'permission');
  check(
    '回答第一项后再显示第二项',
    shownAfterAnswer.length === 2 && shownAfterAnswer[1].requestId === 52,
    JSON.stringify(shownAfterAnswer),
  );

  void panel.onWebviewMessage({ type: 'stop' });
  check('停止按钮确实中止当前会话', session.stopped === 1, String(session.stopped));
  check(
    '停止时把仍等待的第二项回答为取消',
    session.answers.some((item) => item.requestId === 52 && item.optionId === undefined),
    JSON.stringify(session.answers),
  );
  check('停止后权限队列为空', panel.pendingPermissionRequests.size === 0);
  check('停止后通知界面清空权限弹窗', posted.some((item) => item.type === 'permissionClear'));
  check('弹窗清空后的迟到回答被忽略', panel.answerPendingPermission(52, 'once') === false);
}

section('6. 忙碌时不得用历史回放或新会话覆盖当前回答');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('busy-session');
  const posted = [];
  let replayed = 0;
  let started = 0;
  session.busy = true;
  session.start = async () => { started += 1; };
  panel.session = session;
  panel.ensureConnection = async () => session;
  panel.sendHistoryReplay = async () => { replayed += 1; };
  panel.post = (message) => posted.push(message);

  void panel.resumeHistory('history-1');
  check('忙碌时接回历史不会先覆盖当前转录', replayed === 0, String(replayed));
  check(
    '忙碌时接回历史给出明确提示',
    posted.some((item) => item.type === 'notice' && /正在工作/.test(item.text)),
    JSON.stringify(posted),
  );

  posted.length = 0;
  void panel.newSession();
  check('忙碌时不会创建并发的新会话', started === 0, String(started));
  check('忙碌时新建不会清空当前转录', !posted.some((item) => item.type === 'reset'), JSON.stringify(posted));
}

section('7. 旁路操作失败时保持真实的忙碌状态');
{
  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('busy-error');
  const posted = [];
  session.busy = true;
  panel.session = session;
  panel.post = (message) => posted.push(message);
  panel.setModel = () => { throw new Error('切换失败'); };

  void panel.onWebviewMessage({ type: 'setModel', value: 'bad' });
  const busy = posted.filter((item) => item.type === 'busy').at(-1);
  check('旁路错误仍会展示为错误卡片', posted.some((item) => item.type === 'error'));
  check('模型回合仍在执行时停止按钮不会被误关', busy && busy.busy === true, JSON.stringify(posted));
}

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`   - ${failure}`);
  process.exitCode = 1;
}
