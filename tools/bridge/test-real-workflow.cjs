'use strict';

/** Real model and subprocess validation; the editor interaction adapter is synthetic. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { bounded } = require('../compat/test.cjs');
const { safeObject, redact } = require('../compat/lib.cjs');
const { PublicApi } = require('../../packages/vscode-extension/src/api/service');
const { ReviewFixes } = require('../../packages/vscode-extension/src/bridge/fixes');
const { ReviewTests } = require('../../packages/vscode-extension/src/workflow/review-tests');
const { ReportStore } = require('../../packages/vscode-extension/src/bridge/report-store');
const { repositorySnapshot } = require('../../packages/vscode-extension/src/bridge/results');

async function runRealWorkflow({ cwd, folder, client, bridge, session, operationId, result, fingerprint, check }) {
  const events = new EventEmitter(), changes = new EventEmitter(), children = new Set();
  const on = (emitter, event) => callback => { emitter.on(event, callback); return { dispose: () => emitter.off(event, callback) }; };
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath });
  const file = path.join(cwd, 'sample.js'), workspace = { uri: uri(cwd) };
  let text = fs.readFileSync(file, 'utf8'), dirty = false, allowSelection = false, diffShown = false;
  const document = { uri: uri(file), getText: () => text, get isDirty() { return dirty; }, isClosed: false,
    positionAt: offset => ({ offset }), save: async () => { fs.writeFileSync(file, text); dirty = false; changes.emit('save', document); return true; } };
  const task = { name: 'fixture regression', source: 'Workspace', group: { id: 'test' }, scope: workspace, execution: { options: { cwd } } };
  let taskSequence = 0;
  const vscode = {
    Uri: { file: uri }, TaskScope: { Workspace: 2 }, ProgressLocation: { Notification: 15 },
    languages: {},
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { replace(uri, range, after) { this.edit = { uri, range, after }; } },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async command => { if (command === 'vscode.diff') diffShown = true; } },
    window: {
      showQuickPick: async items => items[0]?.edit && !allowSelection ? undefined : items[0],
      showInformationMessage: async message => message.startsWith('应用预览中的') && allowSelection ? '应用此项' : undefined,
      showErrorMessage: async message => { throw new Error(message); },
      withProgress: async (_options, action) => action({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    },
    workspace: {
      isTrusted: true, workspaceFolders: [workspace], textDocuments: [document],
      getWorkspaceFolder: target => target.fsPath === cwd || target.fsPath.startsWith(cwd + path.sep) ? workspace : undefined,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }), openTextDocument: async target => { assert.equal(target.fsPath, file); return document; },
      onDidCloseTextDocument: on(changes, 'close'), onDidChangeTextDocument: on(changes, 'change'), onDidSaveTextDocument: on(changes, 'save'),
      applyEdit: async edit => {
        assert.equal(edit.edit.uri.fsPath, file); assert(diffShown);
        const { start, end } = edit.edit.range;
        text = text.slice(0, start.offset) + edit.edit.after + text.slice(end.offset); dirty = true;
        changes.emit('change', { document }); return true;
      },
    },
    tasks: {
      fetchTasks: async () => [task], onDidStartTaskProcess: on(events, 'start'), onDidEndTaskProcess: on(events, 'exit'), onDidEndTask: on(events, 'end'),
      executeTask: async selected => {
        assert.equal(selected, task);
        const number = ++taskSequence;
        const child = spawn(process.execPath, ['--test', 'sum.test.js'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
        const execution = { terminate: () => child.kill() };
        let output = '';
        const receive = chunk => { if (output.length < 128 * 1024) output += chunk.toString(); };
        child.stdout.on('data', receive); child.stderr.on('data', receive);
        child.on('spawn', () => events.emit('start', { execution, processId: child.pid }));
        child.on('error', () => events.emit('end', { execution }));
        child.on('close', code => {
          children.delete(child); fs.writeFileSync(path.join(folder, `regression-${number}.log`), redact(output));
          events.emit('exit', { execution, exitCode: code }); events.emit('end', { execution });
        });
        return execution;
      },
    },
  };
  const context = { subscriptions: [] };
  const connections = Object.assign(new EventEmitter(), { client, bridge, sessions: new Map(), turns: new Map(),
    ensure: async () => client, snapshot: () => ({ instanceId: 'real-workflow-validation' }), acquire() {}, release() {},
    setSession(surface, value) { this.sessions.set(surface, value); },
    async runSession(value, action) { assert(!this.turns.has(value.sessionId)); this.turns.set(value.sessionId, true); try { return await action(); } finally { this.turns.delete(value.sessionId); } },
  });
  const panel = { wantedPreset: () => 'minimal', config: () => ({}), workdir: () => cwd };
  const workflow = { panel, latest: { id: 'unrelated-chat-turn' }, testResult: { id: 'unrelated-chat-test' }, publish() {} };
  const reportStore = new ReportStore({ directory: path.join(folder, 'workflow-reports') });
  const op = { id: operationId, cwd, status: 'completed', fingerprint, input: { mode: 'worktree' }, result, finishedAt: new Date().toISOString() };
  const saveReport = async value => { Object.assign(value, await reportStore.save(value, value.result)); value.savedKey = value.key; };
  const operations = new Map([[op.id, op]]);
  const views = { connections, operations, reportStore, saveReport,
    recordEvidence: (key, evidence) => reportStore.append(key, evidence),
    document: (key, content) => ({ scheme: 'dsh-report', key, content }),
    recordFix: async (id, evidence) => { const value = operations.get(id); await reportStore.append(value.caseKey, { kind: 'fix', ...evidence }); return value.caseKey; },
    reviewRequest: async request => {
      const before = await repositorySnapshot(cwd); assert(before.hasChanges, 'Re-review requires a nonempty corrected patch.');
      const invoked = await bridge.request('invoke', { requestId: randomUUID(), capabilityId: 'michengai.code-review.run', input: request.input,
        context: { cwd, sessionId: session.sessionId, userInitiated: true, workspaceTrusted: true } });
      let reviewed;
      await bounded((async () => { do {
        reviewed = await bridge.request('operation/get', { operationId: invoked.operationId });
        if (reviewed.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 1000));
      } while (true); })(), 240000);
      assert.equal(reviewed.status, 'completed', JSON.stringify(safeObject(reviewed.result)));
      assert(Array.isArray(reviewed.result.findings)); assert(reviewed.result.rawText?.length > 0);
      assert.equal(reviewed.result.findings.length, 0, 'The corrected numeric sum still has review findings.');
      assert.equal((await repositorySnapshot(cwd)).fingerprint, before.fingerprint);
      const next = { id: invoked.operationId, cwd, status: 'completed', fingerprint: before.fingerprint, input: request.input, result: reviewed.result,
        caseKey: request.caseKey, finishedAt: new Date().toISOString() };
      await saveReport(next); operations.set(next.id, next);
      await reportStore.append(op.caseKey, { kind: 'review', key: next.savedKey });
      fs.writeFileSync(path.join(folder, 're-review-report.json'), JSON.stringify(safeObject(reviewed.result), null, 2) + '\n');
      return next;
    },
  };
  const api = new PublicApi({ vscode, context, connections, panel, views });
  const fixes = new ReviewFixes({ vscode, context, views });
  const verifier = new ReviewTests({ vscode, views, workflow });
  let repairPermission, repairTools = 0;
  fixes.api = { ...api.exports, generateText: async (handle, prompt, options) => {
    repairPermission = await client.permissionGet(handle.sessionId);
    assert.equal(repairPermission.currentValue, 'read-only');
    const receive = (method, params) => { if (method === 'session/update' && params?.sessionId === handle.sessionId && /tool_call/.test(params.update?.sessionUpdate || '')) repairTools++; };
    client.on('notification', receive);
    try {
      const result = await api.exports.generateText(handle, prompt, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) });
      assert.equal(result.path, 'llm-direct-v1'); assert.equal(result.tools, false); return result;
    } finally { client.off('notification', receive); }
  } };
  try {
    await saveReport(op);
    const baseline = await verifier.run(op); await bounded(baseline.finished, 30000);
    assert.equal(baseline.status, 'failed'); assert.equal(baseline.exitCode, 1); assert.equal(baseline.stale, false);
    check('real-independent-regression-before-fix', { executionId: baseline.executionId, exitCode: baseline.exitCode, cwd: 'generated-fixture', interface: 'mock-vscode-task-adapter' });
    const index = result.findings.findIndex(finding => finding.file?.endsWith('sample.js')); assert(index >= 0);
    const planId = await fixes.generate(op.id, index), plan = fixes.plans.get(planId);
    assert(plan?.edits.length); assert.equal(repairTools, 0); assert.equal(document.isDirty, false);
    assert.equal((await repositorySnapshot(cwd)).fingerprint, fingerprint); assert.equal(text, fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(path.join(folder, 'repair-suggestion.json'), JSON.stringify(safeObject(plan.edits), null, 2) + '\n');
    check('real-model-read-only-repair-suggestion', { permission: repairPermission.currentValue, generationPath: 'llm-direct-v1', toolsEnabled: false, edits: plan.edits.length, toolEvents: repairTools, workspaceUnchanged: true });
    allowSelection = true;
    for (let index = 0; index < plan.edits.length; index++) await fixes.apply(planId);
    assert(diffShown && plan.edits.every(edit => edit.applied)); assert.equal(document.isDirty, true);
    assert.equal((await repositorySnapshot(cwd)).fingerprint, fingerprint);
    check('real-repair-editor-application', { interface: 'mock-vscode-editor-adapter', previewed: true, saved: false, diskUnchanged: true });
    await document.save();
    const verified = await verifier.run(op); await bounded(verified.finished, 30000);
    assert.equal(verified.status, 'passed'); assert.equal(verified.exitCode, 0); assert.equal(verified.stale, false);
    assert.notEqual(verified.executionId, baseline.executionId);
    assert.equal(workflow.latest.id, 'unrelated-chat-turn'); assert.equal(workflow.testResult.id, 'unrelated-chat-test');
    check('real-independent-regression-after-fix', { executionId: verified.executionId, exitCode: verified.exitCode, separateFromChat: true, distinctExecution: true });
    const again = await fixes.verify(planId);
    assert.notEqual(again.id, op.id); assert.equal(again.caseKey, op.caseKey);
    check('real-model-re-review', { findings: again.result.findings.length, sameCase: true, distinctOperation: true, workspaceUnchanged: true });
    await reportStore.pending;
    const reopened = new ReportStore({ directory: reportStore.directory });
    assert.equal((await reopened.read(op.savedKey)).report.rawText, result.rawText);
    assert.equal((await reopened.read(again.savedKey)).report.rawText, again.result.rawText);
    const evidence = await reopened.events(op.caseKey);
    const completed = evidence.filter(event => event.payload.kind === 'test' && event.payload.status !== 'running');
    assert(completed.some(event => event.payload.executionId === baseline.executionId && event.payload.exitCode === 1));
    assert(completed.some(event => event.payload.executionId === verified.executionId && event.payload.exitCode === 0));
    check('real-workflow-durable-offline-read', { reviews: 2, testExecutions: 2, exactRawText: true, source: 'local-report-store' });
  } finally {
    verifier.dispose(); api.dispose(); context.subscriptions.forEach(item => item.dispose());
    for (const child of children) child.kill();
    await reportStore.dispose();
  }
}

module.exports = { runRealWorkflow };
