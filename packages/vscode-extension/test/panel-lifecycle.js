'use strict';

/** 面板视图销毁、主动断开与异常断开的纯生命周期回归测试。 */

const Module = require('node:module');
const { EventEmitter } = require('node:events');
const net = require('node:net');

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
    getConfiguration: () => ({
      get: (key) => config[key],
      inspect: (key) => ({ globalValue: config[key] }),
    }),
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
  client.closeSession = async () => ({});
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

section('8. 编辑器附件区分磁盘文件与未保存内容');
{
  function editor({ fileName, scheme = 'file', dirty = false, untitled = false, content = 'const now = 2;', selected = '' }) {
    return {
      document: {
        fileName,
        isDirty: dirty,
        isUntitled: untitled,
        languageId: 'javascript',
        uri: {
          scheme,
          fsPath: scheme === 'untitled' ? '' : fileName,
          toString: () => (scheme === 'file' ? `file:///${fileName.replace(/\\/g, '/')}` : `${scheme}:${fileName}`),
        },
        getText: (selection) => (selection ? selected : content),
      },
      selection: selected
        ? { isEmpty: false, start: { line: 2 }, end: { line: 3 } }
        : { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
  }

  const clean = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'D:\\workspace\\src\\app.js' }),
    'D:\\workspace',
  );
  check('已保存文件仍使用按需读取链接', clean.kind === 'file' && clean.uri.startsWith('file:///'), JSON.stringify(clean));
  check('工作区内文件显示相对路径', clean.name === 'src/app.js', clean.name);

  const dotted = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'D:\\workspace\\..cache\\app.js' }),
    'D:\\workspace',
  );
  check('以两个点开头的子目录不会被误判为工作区外', dotted.name === '..cache/app.js', dotted.name);

  const outside = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'D:\\workspace-other\\app.js' }),
    'D:\\workspace',
  );
  check('相邻目录不会被误判为工作区内', outside.name === 'D:\\workspace-other\\app.js', outside.name);

  const dirty = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'D:\\workspace\\src\\dirty.js', dirty: true, content: 'const unsaved = 42;' }),
    'D:\\workspace',
  );
  check('有未保存修改时改带编辑器快照', dirty.kind === 'content' && dirty.text === 'const unsaved = 42;', JSON.stringify(dirty));
  check('有未保存修改时不附带可能过期的磁盘链接', dirty.uri === undefined, JSON.stringify(dirty));
  check('有未保存修改时在附件标签中明确说明', /未保存修改/.test(dirty.detail), dirty.detail);

  const untitled = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'Untitled-1', scheme: 'untitled', dirty: true, untitled: true, content: '临时内容' }),
    'D:\\workspace',
  );
  check('未保存的新文件直接带正文', untitled.kind === 'content' && untitled.text === '临时内容', JSON.stringify(untitled));
  check('未保存的新文件不伪造可读取链接', untitled.uri === undefined && untitled.detail === '未保存文件', JSON.stringify(untitled));

  const dirtySelection = DshPanelView.attachmentFromEditor(
    editor({ fileName: 'D:\\workspace\\src\\dirty.js', dirty: true, selected: 'unsaved();' }),
    'D:\\workspace',
  );
  check('脏文件选区正文照常携带且不附旧磁盘链接',
    dirtySelection.kind === 'selection' && dirtySelection.text === 'unsaved();' && dirtySelection.uri === undefined,
    JSON.stringify(dirtySelection));
}

/** ACP 已握手但 session/new 失败：不得把未初始化会话留给下一次发送。 */
async function checkFailedSessionStart() {
  section('9. 新建会话失败后清掉半成品，下一次操作能够重连');
  let newAttempts = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.method === 'initialize') {
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { protocolVersion: 1, agentInfo: { name: 'test' }, agentCapabilities: {} },
          })}\n`);
        } else if (frame.method === 'dsh-door/status') {
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: 'Method not found' },
          })}\n`);
        } else if (frame.method === 'session/new') {
          newAttempts += 1;
          if (newAttempts >= 3) {
            socket.destroy();
            continue;
          }
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32000, message: '测试：新建失败' },
          })}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const previous = { port: config.port, selfStartPort: config.selfStartPort, autoStart: config.autoStart };
  const port = server.address().port;
  config.port = port;
  config.selfStartPort = port + 1;
  config.autoStart = false;
  try {
    const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
    panel.post = () => {};
    const first = await panel.ensureConnection();
    check('建会话失败会向调用方返回未连接', first === undefined);
    check('失败后不保留未初始化的会话和客户端', panel.session === undefined && panel.client === undefined);
    await panel.ensureConnection();
    check('下一次操作会重新建连并再次尝试 session/new', newAttempts === 2, String(newAttempts));
    panel.teardown();

    const disconnected = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
    const posted = [];
    disconnected.post = (message) => posted.push(message);
    await disconnected.ensureConnection();
    check(
      '建会话途中断线只显示一张错误卡片',
      posted.filter((message) => message.type === 'error').length === 1,
      JSON.stringify(posted),
    );
    check('建会话途中断线同样清空半成品', disconnected.session === undefined && disconnected.client === undefined);
  } finally {
    config.port = previous.port;
    config.selfStartPort = previous.selfStartPort;
    config.autoStart = previous.autoStart;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function checkExplicitNewSessionFailure() {
  section('10. 主动新建失败同样清理；模式切换不得假报成功');

  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('old-session');
  const client = fakeClient();
  const posted = [];
  session.busy = false;
  session.start = async () => { throw new Error('测试：主动新建失败'); };
  panel.post = (message) => posted.push(message);
  panel.session = session;
  panel.client = client;
  panel.wire(session, client);
  const result = await panel.newSession();
  check('主动新建失败向调用方返回 false', result === false, String(result));
  check('主动新建失败后不保留已关闭的旧会话', panel.session === undefined && panel.client === undefined);
  check('主动新建的业务失败只显示一张错误卡片', posted.filter((item) => item.type === 'error').length === 1);

  const disconnected = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const disconnectSession = fakeSession('disconnect-old');
  const disconnectClient = fakeClient();
  const disconnectPosted = [];
  disconnectSession.busy = false;
  disconnectSession.start = async () => {
    disconnectClient.emit('close', '新建途中断线');
    throw new Error('新建途中断线');
  };
  disconnected.post = (message) => disconnectPosted.push(message);
  disconnected.session = disconnectSession;
  disconnected.client = disconnectClient;
  disconnected.wire(disconnectSession, disconnectClient);
  const disconnectedResult = await disconnected.newSession();
  check('主动新建途中断线返回 false', disconnectedResult === false, String(disconnectedResult));
  check(
    '主动新建途中断线只显示断线处理的一张错误卡片',
    disconnectPosted.filter((item) => item.type === 'error').length === 1,
    JSON.stringify(disconnectPosted),
  );

  const presetPanel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const presetPosted = [];
  presetPanel.session = fakeSession('preset-session');
  presetPanel.turnSent = false;
  presetPanel.post = (message) => presetPosted.push(message);
  presetPanel.newSession = async () => false;
  await presetPanel.setPreset('minimal');
  check(
    '按模式重建失败时不再提示“已重新开启”',
    !presetPosted.some((item) => item.type === 'notice' && /已按.*重新开启/.test(item.text)),
    JSON.stringify(presetPosted),
  );
}

async function checkConcurrentNewSession() {
  section('11. 连续新建与快速切换模式必须串行');

  const panel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const session = fakeSession('parallel-old');
  const client = fakeClient();
  let releaseClose;
  let closeCalls = 0;
  let startCalls = 0;
  client.closeSession = async () => {
    closeCalls += 1;
    await new Promise((resolve) => { releaseClose = resolve; });
  };
  session.busy = false;
  session.start = async () => { startCalls += 1; };
  panel.session = session;
  panel.client = client;
  panel.post = () => {};

  const first = panel.newSession();
  const second = panel.newSession();
  check('连续新建共用同一个进行中的操作', first === second);
  await Promise.resolve();
  releaseClose();
  await Promise.all([first, second]);
  check('连续新建只关闭一次旧会话', closeCalls === 1, String(closeCalls));
  check('连续新建只创建一段新会话', startCalls === 1, String(startCalls));

  client.closeSession = async () => { closeCalls += 1; };
  await panel.newSession();
  check('前一次完成后仍可正常再次新建', closeCalls === 2 && startCalls === 2, `${closeCalls}/${startCalls}`);

  const sendPanel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const sendSession = fakeSession('send-old');
  const sendClient = fakeClient();
  let releaseStart;
  let startFinished = false;
  let sent = false;
  sendSession.busy = false;
  sendSession.start = async () => {
    await new Promise((resolve) => { releaseStart = resolve; });
    startFinished = true;
  };
  sendSession.send = async () => { sent = true; };
  sendPanel.session = sendSession;
  sendPanel.client = sendClient;
  sendPanel.post = () => {};
  const changing = sendPanel.newSession();
  await Promise.resolve();
  await Promise.resolve();
  const sending = sendPanel.send('不要发给旧会话');
  await Promise.resolve();
  check('新会话尚未建好时消息不会提前发出', sent === false);
  releaseStart();
  await Promise.all([changing, sending]);
  check('新会话建好后等待中的消息正常发出', startFinished && sent);

  const presetPanel = new DshPanelView({ extensionUri: { fsPath: 'D:/extension' }, log: () => {}, kernels: fakeKernels() });
  const presetSession = fakeSession('preset-old');
  const presetClient = fakeClient();
  const startedPresets = [];
  const posted = [];
  presetSession.busy = false;
  presetSession.start = async ({ preset }) => { startedPresets.push(preset); };
  presetPanel.session = presetSession;
  presetPanel.client = presetClient;
  presetPanel.post = (message) => posted.push(message);
  const minimal = presetPanel.setPreset('minimal');
  const cordis = presetPanel.setPreset('cordis');
  await Promise.all([minimal, cordis]);
  check('快速模式切换按顺序创建且最终使用最后选择',
    startedPresets.join(',') === 'minimal,cordis',
    startedPresets.join(','));
  const successes = posted.filter((item) => item.type === 'notice' && /已按.*重新开启/.test(item.text));
  check('被后续选择取代的模式不会再提示成功',
    successes.length === 1 && /cordis/.test(successes[0].text),
    JSON.stringify(successes));
}

function finish() {
  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const failure of failures) console.log(`   - ${failure}`);
    process.exitCode = 1;
  }
}

async function runAsyncChecks() {
  await checkFailedSessionStart();
  await checkExplicitNewSessionFailure();
  await checkConcurrentNewSession();
}

runAsyncChecks().then(finish, (error) => {
  failures.push(`新建会话失败回归自身异常（${error && error.stack ? error.stack : error}）`);
  finish();
});
