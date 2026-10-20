'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ReportStore } = require('../src/bridge/report-store');
const { ReviewTests } = require('../src/workflow/review-tests');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-verification-'));
  try {
    const cwd = path.join(root, 'repo'); await fs.mkdir(cwd); const file = path.join(cwd, 'sample.js'); await fs.writeFile(file, 'const fixed = true;\n');
    const taskEvents = new EventEmitter(), changes = new EventEmitter(); const on = (emitter, event) => fn => { emitter.on(event, fn); return { dispose: () => emitter.off(event, fn) }; };
    const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath }); const folder = { uri: uri(cwd) };
    const task = { name: 'fixture test', source: 'Workspace', group: { id: 'test' }, scope: folder, execution: { options: { cwd } } };
    let executions = [], dirty = false;
    const vscode = { Uri: { file: uri }, TaskScope: { Workspace: 2 },
      window: { showQuickPick: async items => items[0], showInformationMessage: async () => {} },
      workspace: { isTrusted: true, workspaceFolders: [folder], textDocuments: [{ uri: uri(file), get isDirty() { return dirty; }, getText: () => 'const fixed = true;\n' }],
        getWorkspaceFolder: target => target.fsPath === cwd ? folder : undefined,
        onDidCloseTextDocument: on(changes, 'close'), onDidChangeTextDocument: on(changes, 'change') },
      tasks: { fetchTasks: async () => [task], onDidStartTaskProcess: on(taskEvents, 'start'), onDidEndTaskProcess: on(taskEvents, 'exit'), onDidEndTask: on(taskEvents, 'end'),
        executeTask: async () => { const execution = { terminated: false, terminate() { this.terminated = true; } }; executions.push(execution); return execution; } },
    };
    const reportStore = new ReportStore({ directory: path.join(root, 'reports') });
    const op = { id: 'review', cwd, status: 'completed', input: { mode: 'worktree' }, result: { findings: [] }, finishedAt: new Date().toISOString() };
    Object.assign(op, await reportStore.save(op, op.result)); op.savedKey = op.key;
    await reportStore.append(op.caseKey, { kind: 'fix', file: 'sample.js', before: 'bad', after: 'good' });
    const views = { reportStore, saveReport: async () => {}, recordEvidence: (key, event) => reportStore.append(key, event) };
    const workflow = { panel: { workdir: () => '/UNRELATED_CHAT' }, publish() {}, latest: undefined };
    const verifier = new ReviewTests({ vscode, views, workflow });
    const fail = await verifier.run(op); assert.equal(workflow.activeTest, true); assert.equal(fail.cwd, cwd);
    assert.equal(workflow.testResult, undefined, 'Review verification never replaces unrelated chat test results');
    await assert.rejects(verifier.run(op), /结束/);
    taskEvents.emit('exit', { execution: executions[0], exitCode: 1 }); await fail.finished; assert.equal(fail.status, 'failed');
    workflow.latest = { id: 'unrelated' }; workflow.testResult = { id: 'other-test' };
    const pass = await verifier.run(op); assert.notEqual(pass.executionId, fail.executionId);
    verifier.cancel(fail.executionId); assert.equal(executions[1].terminated, false);
    taskEvents.emit('exit', { execution: executions[0], exitCode: 1 }); assert.equal(pass.status, 'running');
    taskEvents.emit('exit', { execution: executions[1], exitCode: 0 }); await pass.finished; assert.equal(pass.status, 'passed'); assert.equal(pass.outputSource, 'unavailable');
    assert.equal(workflow.testResult.id, 'other-test'); assert.equal(workflow.latest.id, 'unrelated');
    changes.emit('change', { document: { uri: uri(file) } }); assert.equal(pass.stale, true);
    const cancelled = await verifier.run(op); verifier.cancel(cancelled.executionId); taskEvents.emit('exit', { execution: executions[2], exitCode: 0 }); await cancelled.finished; assert.equal(cancelled.status, 'cancelled');
    const unknown = await verifier.run(op); taskEvents.emit('end', { execution: executions[3] }); await unknown.finished; assert.equal(unknown.status, 'unknown');
    const cleanFinish = await verifier.run(op), actualUnpin = reportStore.unpin.bind(reportStore);
    reportStore.unpin = async () => { throw new Error('Fixture cleanup contention'); };
    taskEvents.emit('exit', { execution: executions.at(-1), exitCode: 0 }); await cleanFinish.finished;
    assert.equal(cleanFinish.status, 'passed'); assert.equal(workflow.activeTest, false); assert.equal(verifier.current, undefined);
    reportStore.unpin = actualUnpin;
    const createdConfig = await verifier.run(op); await fs.mkdir(path.join(cwd, '.vscode')); await fs.writeFile(path.join(cwd, '.vscode/tasks.json'), '{}');
    taskEvents.emit('exit', { execution: executions.at(-1), exitCode: 0 }); await createdConfig.finished;
    assert.equal(createdConfig.status, 'passed'); assert.equal(createdConfig.stale, true, 'Creating missing task configuration invalidates recorded scope');
    dirty = true; await assert.rejects(verifier.run(op), /保存/); dirty = false; assert.equal(workflow.activeTest, false);
    vscode.workspace.isTrusted = false; await assert.rejects(verifier.run(op), /受信任/); vscode.workspace.isTrusted = true;
    await reportStore.pending;
    const events = await reportStore.events(op.caseKey); const ids = new Set(events.filter(event => event.payload.kind === 'test').map(event => event.payload.executionId)); assert.equal(ids.size, 7);
    const history = new ReportStore({ directory: reportStore.directory }); assert.equal((await history.events(op.caseKey)).length, events.length);
    verifier.dispose(); await reportStore.dispose();
    console.log('Independent review scope, real exit status, reruns, late cancellation, unknown exits, unsaved files and durable executions passed');
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
