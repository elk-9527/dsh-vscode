'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TurnWorkflow, lineChanges, MAX_TURNS, MAX_HISTORY_BYTES } = require('../src/workflow/turns');
const { WorkspaceTests, MAX_LOG_BYTES } = require('../src/workflow/tests');
const { snapshotMessage } = require('../src/panel/queue');
const { commandChoices } = require('../src/workflow/commands');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workflow-'));
const cwd = path.join(root, 'project'), outside = path.join(root, 'outside'); fs.mkdirSync(cwd); fs.mkdirSync(outside);
const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => 'file:' + fsPath });
const folder = { uri: uri(cwd) }, subscriptions = {}, documents = [], sent = []; let currentCwd = cwd, approve = true, applyCount = 0;
const disposable = { dispose() {} };
function document(file) {
  let doc = documents.find(item => item.uri.fsPath === file);
  if (!doc) { doc = { uri: uri(file), text: fs.readFileSync(file, 'utf8'), isDirty: false, version: 1, getText() { return this.text; }, positionAt(offset) { return offset; } }; documents.push(doc); }
  return doc;
}
const vscode = {
  Uri: { file: uri, parse: value => ({ toString: () => value }) }, RelativePattern: class {}, Range: class {},
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ kind: 'replace', uri, text }); } createFile(uri) { this.edits.push({ kind: 'create', uri }); } deleteFile(uri) { this.edits.push({ kind: 'delete', uri }); } },
  TaskScope: { Workspace: 2 }, DiagnosticSeverity: { Error: 0 },
  workspace: { isTrusted: true, textDocuments: documents, workspaceFolders: [folder], getWorkspaceFolder: value => value.fsPath.startsWith(cwd) ? folder : undefined,
    onDidChangeTextDocument: fn => { subscriptions.document = fn; return disposable; },
    onDidSaveTextDocument: fn => { subscriptions.save = fn; return disposable; },
    registerTextDocumentContentProvider: () => disposable, findFiles: async () => fs.readdirSync(cwd).filter(name => fs.statSync(path.join(cwd, name)).isFile()).map(name => uri(path.join(cwd, name))),
    openTextDocument: async value => document(value.fsPath), applyEdit: async edit => {
      applyCount++; for (const item of edit.edits) {
        if (item.kind === 'delete') fs.unlinkSync(item.uri.fsPath);
        else if (item.kind === 'create') fs.writeFileSync(item.uri.fsPath, '');
        else { const doc = document(item.uri.fsPath); doc.text = item.text; doc.isDirty = true; doc.version++; }
      } return true;
    } },
  commands: { executeCommand: async (...args) => sent.push(args) },
  window: { showInformationMessage: async () => approve ? '撤销此文件' : undefined, showQuickPick: async items => items[0] },
  languages: { getDiagnostics: () => [] },
  tasks: { onDidStartTaskProcess: fn => { subscriptions.start = fn; return disposable; }, onDidEndTaskProcess: fn => { subscriptions.process = fn; return disposable; }, onDidEndTask: fn => { subscriptions.end = fn; return disposable; } },
};
const panel = { workdir: () => currentCwd, post: value => sent.push(value), reveal: async () => {}, attach: async value => { panel.attached = value; } };
const workflow = new TurnWorkflow({ vscode, panel }); panel.workflow = workflow;
(async () => {
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const file = path.join(cwd, 'a.js'); fs.writeFileSync(file, 'old\n'); execFileSync('git', ['add', 'a.js'], { cwd, windowsHide: true });
  fs.writeFileSync(file, 'existing local edit\n');
  const turn = await workflow.begin(); fs.writeFileSync(file, 'agent edit\n'); await workflow.finish(turn);
  assert.equal(workflow.summary().files.length, 1); assert.equal(turn.files[0].before.text, 'existing local edit\n');
  assert.equal(turn.status, 'completed'); assert.equal(workflow.summary().turns[0].turnId, turn.id);
  assert.equal(workflow.summary().turns[0].finished, true);
  const id = turn.files[0].id;
  panel.session = { busy: false }; panel.queue = { active: { id: 'preparing-message' } };
  await assert.rejects(workflow.undo(id), /当前任务/); assert.equal(applyCount, 0);
  delete panel.queue; delete panel.session;
  panel.newSessionPending = Promise.resolve();
  await assert.rejects(workflow.undo(id), /当前任务/); assert.equal(applyCount, 0);
  delete panel.newSessionPending;
  const originalConfirmation = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async () => { panel.newSessionPending = Promise.resolve(); return '撤销此文件'; };
  await assert.rejects(workflow.undo(id), /当前任务/); assert.equal(applyCount, 0);
  delete panel.newSessionPending; vscode.window.showInformationMessage = originalConfirmation;
  vscode.window.showInformationMessage = async () => { panel.queue = { active: { id: 'finishing-message' } }; return '撤销此文件'; };
  await assert.rejects(workflow.undo(id), /当前任务/); assert.equal(applyCount, 0);
  delete panel.queue; vscode.window.showInformationMessage = originalConfirmation;
  approve = false; await workflow.undo(id); assert.equal(applyCount, 0); approve = true;
  fs.writeFileSync(file, 'later user edit\n'); await assert.rejects(workflow.undo(id), /又被修改/); assert.equal(applyCount, 0);
  fs.writeFileSync(file, 'agent edit\n');
  const originalOpenTextDocument = vscode.workspace.openTextDocument;
  vscode.workspace.openTextDocument = async value => { const opened = await originalOpenTextDocument(value); panel.queue = { active: { id: 'before-apply-message' } }; return opened; };
  await assert.rejects(workflow.undo(id), /文件或回合已变化/); assert.equal(applyCount, 0);
  delete panel.queue; vscode.workspace.openTextDocument = originalOpenTextDocument;
  await workflow.undo(id);
  assert.equal(document(file).getText(), 'existing local edit\n'); assert.equal(fs.readFileSync(file, 'utf8'), 'agent edit\n'); assert.equal(workflow.summary().files[0].restored, true);
  // 未保存的用户内容是基线；外部写入磁盘时不能用撤销覆盖它。
  const next = await workflow.begin(); fs.writeFileSync(file, 'external changed\n'); await workflow.finish(next);
  assert.equal(workflow.summary().files[0].canUndo, false);
  assert.equal(workflow.records.length, 2); await workflow.preview(id);
  assert.equal(workflow.summary().turns[1].files[0].canUndo, false);
  await assert.rejects(workflow.undo(id), /历史改动/);
  documents.length = 0;
  const more = await workflow.begin(); const created = path.join(cwd, 'new.txt'); fs.writeFileSync(created, 'new'); fs.unlinkSync(file); await workflow.finish(more);
  assert.deepEqual(more.files.map(item => item.kind).sort(), ['added', 'deleted']);
  await workflow.undo(more.files.find(item => item.kind === 'added').id); assert(!fs.existsSync(created));
  await workflow.undo(more.files.find(item => item.kind === 'deleted').id); assert.equal(document(file).text, 'external changed\n');
  currentCwd = outside; await assert.rejects(workflow.preview(id), /失效|工作区/); currentCwd = cwd;
  vscode.workspace.isTrusted = false; assert.equal(await workflow.begin(), undefined); vscode.workspace.isTrusted = true;
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside'); fs.symlinkSync(outside, path.join(cwd, 'linked'), 'junction');
  await assert.rejects(workflow.state(path.join(cwd, 'linked/private.txt'), cwd), /外部/);
  await assert.rejects(workflow.state(path.join(cwd, 'linked/deleted.txt'), cwd), /外部/);
  fs.unlinkSync(path.join(cwd, 'linked'));
  fs.writeFileSync(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 2])); fs.writeFileSync(path.join(cwd, 'large.txt'), 'x'.repeat(300000));
  const partial = await workflow.begin(); assert(partial.before.skipped >= 2);
  await workflow.finish(partial, { status: 'cancelled' }); assert.equal(partial.status, 'cancelled');
  await workflow.finish(partial, { status: 'failed' }); assert.equal(partial.status, 'cancelled');
  fs.unlinkSync(path.join(cwd, 'binary.dat')); fs.unlinkSync(path.join(cwd, 'large.txt'));
  assert.deepEqual(lineChanges('a\nb\nc', 'a\nx\nc'), { added: 1, removed: 1 });
  assert.deepEqual(lineChanges('one\n', ''), { added: 0, removed: 1 });
  assert.deepEqual(lineChanges('', 'one\n'), { added: 1, removed: 0 });
  assert.deepEqual(lineChanges('a\nb\nc\nd', 'a\nx\nc\ny'), { added: 2, removed: 2 });
  assert.deepEqual(lineChanges('a\n'.repeat(1200), 'b\n'.repeat(1200)), {});
  assert(commandChoices('model', { busy: true })[0].disabled); assert(commandChoices('help', { trusted: false })[0].disabled === false);
  documents.length = 0;
  const testedTurn = await workflow.begin(); fs.writeFileSync(file, 'code selected for testing\n'); await workflow.finish(testedTurn);
  assert.deepEqual([...testedTurn.before.entries.keys()], ['a.js']);
  const tests = new WorkspaceTests({ vscode, workflow });
  const testIdentity = result => ({ testId: result.id, turnId: result.turnId, requestId: `result-${result.id}`, cwd: result.cwd, sessionId: panel.session?.sessionId });
  const evidence = async () => (await tests.attach(testIdentity(workflow.testResult))).items[0];
  const task = { name: 'Actual test', group: { id: 'test' }, scope: folder, source: 'Workspace' };
  panel.session = { busy: false }; panel.queue = { active: { id: 'preparing-message' } };
  await assert.rejects(tests.run(), /当前任务/); assert(!workflow.activeTest);
  delete panel.queue; delete panel.session;
  panel.newSessionPending = Promise.resolve();
  await assert.rejects(tests.run(), /当前任务/);
  delete panel.newSessionPending;
  vscode.tasks.fetchTasks = async () => [{ ...task, group: { id: 'build' } }, { ...task, scope: { uri: uri(outside) } }, task];
  let execution;
  vscode.tasks.executeTask = async () => execution = { terminate() { subscriptions.process({ execution, exitCode: undefined }); } };
  const originalPicker = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async items => { panel.newSessionPending = Promise.resolve(); return items[0]; };
  await assert.rejects(tests.run(), /当前任务/); assert(!workflow.activeTest);
  delete panel.newSessionPending; vscode.window.showQuickPick = originalPicker;
  vscode.window.showQuickPick = async items => { panel.queue = { active: { id: 'accepted-message' } }; return items[0]; };
  await assert.rejects(tests.run(), /当前任务/); assert(!workflow.activeTest);
  delete panel.queue; vscode.window.showQuickPick = originalPicker;
  let executeCalls = 0;
  vscode.tasks.executeTask = async () => { executeCalls++; return execution = { terminate() { subscriptions.process({ execution, exitCode: undefined }); } }; };
  const scopeCases = [
    ['session', () => { panel.session = { sessionId: 'other', busy: false }; }, () => { delete panel.session; }],
    ['epoch', () => { panel.queueEpoch = 5; }, () => { delete panel.queueEpoch; }],
    ['trust epoch', () => { panel.contextTrustEpoch = 2; }, () => { delete panel.contextTrustEpoch; }],
    ['session serial', () => { panel.contextSessionSerial = 4; }, () => { delete panel.contextSessionSerial; }],
    ['trust', () => { vscode.workspace.isTrusted = false; }, () => { vscode.workspace.isTrusted = true; }],
    ['latest turn', () => { workflow.latest = { id: 'different-round' }; }, () => { workflow.latest = testedTurn; }],
  ];
  for (const [name, change, restore] of scopeCases) {
    vscode.window.showQuickPick = async items => { change(); return items[0]; };
    await assert.rejects(tests.run(), /变化|工作区/, name); restore(); assert.equal(executeCalls, 0, name);
  }
  vscode.window.showQuickPick = originalPicker;
  const originalFetchTasks = vscode.tasks.fetchTasks;
  vscode.tasks.fetchTasks = async () => { panel.session = { sessionId: 'fetch-race' }; return [task]; };
  await assert.rejects(tests.run(), /变化/); delete panel.session; assert.equal(executeCalls, 0);
  vscode.tasks.fetchTasks = originalFetchTasks;
  await assert.rejects(tests.run({ turnId: 'old-turn' }), /回合/);
  await assert.rejects(tests.run({ current: () => false }), /变化/);
  vscode.window.showQuickPick = async () => undefined; await tests.run(); assert.equal(executeCalls, 0);
  vscode.window.showQuickPick = originalPicker;
  const cleanState = workflow.state;
  workflow.state = async (...args) => { const state = await cleanState.call(workflow, ...args); panel.queue = { active: { id: 'capture-race' } }; return state; };
  await assert.rejects(tests.run(), /当前任务/); delete panel.queue; workflow.state = cleanState;
  assert.equal(executeCalls, 0); assert.equal(workflow.testResult.status, 'error'); assert(!workflow.activeTest);
  let racedTerminations = 0;
  vscode.tasks.executeTask = async () => { executeCalls++; panel.session = { sessionId: 'execute-race' }; return { terminate() { racedTerminations++; } }; };
  await assert.rejects(tests.run(), /变化/); delete panel.session;
  assert.equal(racedTerminations, 1); assert.equal(workflow.testResult.status, 'error'); assert(!workflow.activeTest);
  vscode.tasks.executeTask = async () => execution = { terminate() { subscriptions.process({ execution, exitCode: undefined }); } };
  await tests.run(); assert.equal(workflow.testResult.status, 'running'); assert(workflow.activeTest);
  // A retained execution belongs to the session, not the view/request which started it.
  panel.queueEpoch = 1;
  tests.cancel(testIdentity(workflow.testResult));
  assert.equal(workflow.testResult.status, 'cancelled');
  delete panel.queueEpoch;
  await tests.run();
  subscriptions.process({ execution: {}, exitCode: 0 }); assert(workflow.activeTest);
  subscriptions.process({ execution, exitCode: 0 }); assert.equal(workflow.testResult.status, 'passed'); assert(!workflow.activeTest);
  await tests.refreshFreshness(); assert.equal(workflow.testResult.freshness, 'current'); assert.equal(workflow.testResult.trackedFilesCount, 1);
  assert.equal(testedTurn.test, workflow.testResult); assert.equal(testedTurn.test.turnId, testedTurn.id);
  fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'unrelated change'); await tests.refreshFreshness();
  assert.equal(workflow.testResult.freshness, 'current'); fs.unlinkSync(path.join(cwd, 'unrelated.txt'));
  const sameTextDirty = document(file); sameTextDirty.isDirty = true; sameTextDirty.version++;
  await tests.preview(testIdentity(workflow.testResult)); assert.equal(workflow.testResult.freshness, 'unknown'); assert.equal(workflow.testResult.stale, false);
  assert(workflow.testResult.freshnessNote.includes('当前有未保存'));
  sameTextDirty.isDirty = false; await tests.refreshFreshness(); assert.equal(workflow.testResult.freshness, 'current');
  subscriptions.save(document(file)); await tests.refreshFreshness(); assert.equal(workflow.testResult.stale, false);
  let attached = await evidence(); assert(attached.text.includes('不包含任务终端输出')); assert(attached.text.includes('结果：通过'));
  fs.writeFileSync(file, 'edit after tests passed\n');
  attached = await evidence(); assert.equal(workflow.testResult.stale, true); assert.equal(workflow.testResult.status, 'passed');
  assert(attached.text.includes('此结果不能验证当前内容'));
  documents.length = 0;
  await tests.run();
  const edited = document(file); edited.text = 'unsaved later edit\n'; edited.isDirty = true; edited.version++;
  subscriptions.document({ document: edited }); assert.equal(workflow.testResult.stale, true);
  subscriptions.process({ execution, exitCode: 0 }); await tests.refreshFreshness(); assert.equal(workflow.testResult.freshness, 'stale');
  await tests.run(); subscriptions.process({ execution, exitCode: 0 }); await tests.refreshFreshness();
  assert.equal(workflow.testResult.freshness, 'unknown'); assert(workflow.testResult.freshnessNote.includes('未保存'));
  documents.length = 0;
  await tests.run(); subscriptions.process({ execution, exitCode: 1 }); assert.equal(workflow.testResult.status, 'failed');
  const failedResult = workflow.testResult, failedIdentity = testIdentity(failedResult), postsBeforeEvidence = sent.length;
  let sendCalls = 0, queueCalls = 0; panel.send = async () => { sendCalls++; }; panel.session = undefined;
  panel.queue = { add() { queueCalls++; } };
  const preview = await tests.preview(failedIdentity), added = await tests.attach(failedIdentity), prepared = await tests.prepare(failedIdentity);
  assert.equal(preview.items[0].text, added.items[0].text); assert.equal(preview.items[0].text, prepared.items[0].text);
  assert(prepared.text.includes('此次失败')); assert(prepared.text.includes('重新运行'));
  assert(preview.items[0].text.includes('本次未自动取得终端输出'));
  assert(preview.items[0].text.includes(failedResult.id)); assert(preview.items[0].text.includes(testedTurn.id));
  assert.equal(preview.items[0].scope, 'test'); assert(sent.slice(postsBeforeEvidence).every(message => message.type === 'workflow'));
  await assert.rejects(tests.preview({ ...failedIdentity, testId: 'old-id' }), /覆盖|淘汰/);
  await assert.rejects(tests.attach({ ...failedIdentity, turnId: 'other-turn' }), /覆盖|淘汰/);
  await assert.rejects(tests.prepare({ ...failedIdentity, requestId: undefined }), /身份/);
  const withLog = await tests.supplement(failedIdentity, '\u001b[31mFAILED\u001b[0m\n<img src=x onerror=alert(1)>\u0000\u0007');
  assert(withLog.items[0].text.includes('用户明确提供的日志（未自动核实属于此次执行）'));
  assert(withLog.items[0].text.includes('<img src=x onerror=alert(1)>')); assert(!withLog.items[0].text.includes('\u001b')); assert(!withLog.items[0].text.includes('\u0000'));
  assert.equal(failedResult.userLog.source, 'user-provided'); assert.equal(failedResult.userLog.verified, false);
  assert.equal(withLog.items[0].turnId, testedTurn.id); assert.equal(withLog.items[0].testId, failedResult.id);
  assert.equal(withLog.items[0].sourcePath, cwd); assert(!Number.isNaN(Date.parse(withLog.items[0].snapshotAt)));
  const retainedLog = failedResult.userLog;
  const historyWithLog = workflow.historyBytes; failedResult.userLog = undefined; workflow.compact();
  assert.equal(historyWithLog - workflow.historyBytes, retainedLog.byteLength); failedResult.userLog = retainedLog; workflow.compact();
  await assert.rejects(tests.supplement(failedIdentity, 'x'.repeat(MAX_LOG_BYTES + 1)), /128 KiB/); assert.equal(failedResult.userLog, retainedLog);
  await assert.rejects(tests.supplement(failedIdentity, '\u0000'.repeat(MAX_LOG_BYTES)), /128 KiB/); assert.equal(failedResult.userLog, retainedLog);
  assert.throws(() => snapshotMessage('existing body', [{ kind: 'content', name: 'existing', text: 'x'.repeat(256 * 1024) }, ...withLog.items]), /总量/);
  assert.throws(() => snapshotMessage('existing body', [...Array.from({ length: 20 }, (_, index) => ({ kind: 'content', name: String(index), text: 'x' })), ...withLog.items]), /20/);
  const beforeTerminal = sent.length; await tests.openTerminal(failedIdentity);
  assert.deepEqual(sent[beforeTerminal], ['workbench.action.terminal.focus']);
  assert.equal(sendCalls, 0); assert.equal(queueCalls, 0); delete panel.send; delete panel.queue;
  await tests.run();
  assert(!tests.snapshots.has(failedIdentity.testId));
  assert.throws(() => tests.cancel(failedIdentity), /覆盖|淘汰/); assert.equal(workflow.testResult.status, 'running');
  await assert.rejects(tests.preview(failedIdentity), /覆盖|淘汰/); subscriptions.process({ execution, exitCode: 1 });
  // A scope change while freshness is pending rejects the evidence instead of moving it to another draft.
  const activeIdentity = testIdentity(workflow.testResult), stateBeforeRace = workflow.state;
  workflow.state = async (...args) => { const state = await stateBeforeRace.call(workflow, ...args); panel.queueEpoch = 10; return state; };
  await assert.rejects(tests.attach(activeIdentity), /变化/); delete panel.queueEpoch; workflow.state = stateBeforeRace;
  assert.equal(sendCalls, 0); assert.equal(queueCalls, 0);
  const diagnosticsBefore = vscode.languages.getDiagnostics;
  vscode.languages.getDiagnostics = () => [[uri(file), [{ severity: 0, range: { start: { line: 0 } }, message: 'pre-existing editor error' }]]];
  await tests.run(); subscriptions.process({ execution, exitCode: 1 });
  const diagnosticEvidence = await tests.preview(testIdentity(workflow.testResult));
  assert(diagnosticEvidence.items[0].text.includes('不是此次执行日志')); assert(diagnosticEvidence.items[0].text.includes('pre-existing editor error'));
  vscode.languages.getDiagnostics = diagnosticsBefore;
  await tests.run(); tests.cancel(testIdentity(workflow.testResult)); assert.equal(workflow.testResult.status, 'cancelled'); assert(!workflow.activeTest);
  const cancelledDraft = await tests.prepare(testIdentity(workflow.testResult)); assert(cancelledDraft.text.includes('排查')); assert(!cancelledDraft.text.includes('此次失败'));
  let terminationCalls = 0;
  vscode.tasks.executeTask = async () => execution = { terminate() { terminationCalls++; if (terminationCalls === 2) subscriptions.process({ execution, exitCode: undefined }); } };
  await tests.run(); tests.cancel(testIdentity(workflow.testResult)); assert.equal(workflow.testResult.status, 'cancelling'); subscriptions.start({ execution });
  assert.equal(workflow.testResult.status, 'cancelled'); assert.equal(terminationCalls, 2);
  vscode.tasks.executeTask = async () => execution = { terminate() {} };
  await tests.run(); subscriptions.end({ execution }); await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(workflow.testResult.status, 'unknown');
  const unknownDraft = await tests.prepare(testIdentity(workflow.testResult)); assert(unknownDraft.text.includes('排查')); assert(!unknownDraft.text.includes('此次失败'));
  vscode.tasks.executeTask = async () => { throw new Error('configured test failed to start'); };
  await assert.rejects(tests.run(), /failed to start/); assert.equal(workflow.testResult.status, 'error'); assert(!workflow.activeTest);
  assert((await tests.preview(testIdentity(workflow.testResult))).items[0].text.includes('结果：启动失败'));
  // 进程结束事件可以早于 executeTask 的 Promise 返回。
  vscode.tasks.executeTask = async () => { execution = {}; subscriptions.process({ execution, exitCode: 0 }); return execution; };
  await tests.run(); assert.equal(workflow.testResult.status, 'passed'); assert(!workflow.activeTest);
  vscode.window.showQuickPick = async () => { currentCwd = outside; return { label: task.name, task }; };
  await assert.rejects(tests.run(), /工作区/); currentCwd = cwd;
  vscode.window.showQuickPick = originalPicker;
  panel.session = { busy: true }; await assert.rejects(tests.run(), /当前任务/); delete panel.session;
  const retainedTest = workflow.testResult, later = await workflow.begin(); await workflow.finish(later, { status: 'failed' });
  assert.equal(workflow.testResult, undefined); assert.equal(later.status, 'failed'); assert.equal(testedTurn.test, retainedTest);
  assert.equal(workflow.summary().turns.find(item => item.id === testedTurn.id).test.id, retainedTest.id);
  const historicalEvidence = await tests.preview(testIdentity(retainedTest)); assert(historicalEvidence.items[0].text.includes(retainedTest.id));
  panel.session = { sessionId: 'retained-session', busy: false };
  panel.queueEpoch = 20; panel.view = { id: 'initial-view' };
  panel.contextRequestScope = () => ({ view: panel.view, epoch: panel.queueEpoch });
  panel.contextRequestCurrent = scope => scope.view === panel.view && scope.epoch === panel.queueEpoch;
  let initialRequestCurrent = true;
  vscode.tasks.executeTask = async () => execution = { terminate() { subscriptions.process({ execution, exitCode: undefined }); } };
  await tests.run({ current: () => initialRequestCurrent });
  const detached = workflow.testResult;
  panel.view = undefined; panel.queueEpoch++; initialRequestCurrent = false;
  panel.view = { id: 'reopened-view' };
  tests.cancel(testIdentity(detached)); assert.equal(detached.status, 'cancelled');
  // Keep the session and result across a later failed/stopped turn and its queue pause.
  const tracked = await workflow.begin(); fs.writeFileSync(file, 'tracked retained baseline\n'); await workflow.finish(tracked);
  await tests.run(); subscriptions.process({ execution, exitCode: 1 }); await tests.refreshFreshness();
  const oldCompleted = workflow.testResult;
  const stopped = await workflow.begin(); await workflow.finish(stopped, { status: 'cancelled' }); panel.queueEpoch++;
  assert((await tests.preview(testIdentity(oldCompleted))).items[0].text.includes(oldCompleted.id));
  assert((await tests.attach(testIdentity(oldCompleted))).items[0].testId === oldCompleted.id);
  assert((await tests.prepare(testIdentity(oldCompleted))).text.includes('此次失败'));
  const failedLater = await workflow.begin(); await workflow.finish(failedLater, { status: 'failed' }); panel.queueEpoch++;
  assert((await tests.preview(testIdentity(oldCompleted))).items[0].testId === oldCompleted.id);
  fs.writeFileSync(file, 'retained file changed after queue pause\n'); subscriptions.save({ uri: uri(file) });
  await tests.refreshFreshness(oldCompleted); assert.equal(oldCompleted.stale, true); assert.equal(oldCompleted.status, 'failed');
  // Stable provenance still rejects another session and a trust revoke/regrant.
  const sessionBefore = panel.session; panel.session = { ...sessionBefore };
  const expiredProjection = workflow.summary().turns.find(item => item.id === tracked.id).test;
  assert.equal(expiredProjection.sourceCurrent, false); assert(expiredProjection.sourceNote.includes('重新测试'));
  assert.equal(expiredProjection.status, 'failed'); assert.equal(oldCompleted.sourceCurrent, undefined);
  await assert.rejects(tests.preview(testIdentity(oldCompleted)), /变化/); panel.session = sessionBefore;
  assert.equal(workflow.summary().turns.find(item => item.id === tracked.id).test.sourceCurrent, true);
  panel.contextTrustEpoch = 1; await assert.rejects(tests.preview(testIdentity(oldCompleted)), /变化/); delete panel.contextTrustEpoch;
  delete panel.contextRequestScope; delete panel.contextRequestCurrent; delete panel.view; delete panel.queueEpoch; delete panel.session;
  const oldRetainedIdentity = testIdentity(retainedTest);
  workflow.reset(); assert.deepEqual(workflow.summary().turns, []); assert.equal(workflow.historyBytes, 0);
  assert.equal(tests.snapshots.size, 0);
  await assert.rejects(tests.preview(oldRetainedIdentity), /覆盖|淘汰/);
  await tests.run(); subscriptions.process({ execution, exitCode: 0 }); await tests.refreshFreshness();
  assert.equal(workflow.testResult.freshness, 'unknown'); assert.equal(workflow.testResult.trackedFilesCount, 0);
  tests.dispose(); workflow.reset();
  const oldest = [];
  for (let index = 0; index < MAX_TURNS + 2; index++) {
    const record = await workflow.begin({ turnId: `bounded-turn-${index}` }); record.messageId = `message-${index}`;
    fs.writeFileSync(file, `bounded change ${index}\n`); await workflow.finish(record); oldest.push(record);
  }
  assert.equal(workflow.records.length, MAX_TURNS); assert.equal(workflow.summary().turns[0].messageId, `message-${MAX_TURNS + 1}`);
  await assert.rejects(workflow.preview(oldest[0].files[0].id), /失效/);
  const historical = workflow.records[0].files[0]; await workflow.preview(historical.id); await assert.rejects(workflow.undo(historical.id), /历史改动/);
  const memory = new TurnWorkflow({ vscode, panel }), textState = { text: 'x'.repeat(256 * 1024), bytes: 256 * 1024 };
  const big = { id: 'large-round', finished: 1, files: Array.from({ length: 64 }, (_, index) => ({ id: `large-${index}`, before: textState, after: textState })) };
  const small = { id: 'small-round', finished: 2, files: [{ id: 'small', before: textState, after: textState }] };
  memory.records = [big, small]; memory.latest = small; memory.compact();
  assert.equal(memory.records.length, 1); assert(memory.historyBytes <= MAX_HISTORY_BYTES); memory.dispose();
  workflow.dispose(); console.log('Bounded multi-turn snapshots, historical preview, latest-only safe undo, real test outcomes, scoped freshness, editor/disk changes, cancellation and task event races passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
});
