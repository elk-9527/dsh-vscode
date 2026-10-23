'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { QueuePersistence, normalizeQueue, QUEUE_KEY, QUEUE_TTL, QUEUE_BYTES } = require('../src/panel/queue-persistence');
const { MessageQueue, snapshotMessage } = require('../src/panel/queue');
const { DoorTimeoutError } = require('../src/door/client');
const { draftKey } = require('../src/panel/drafts');
const fixtures = path.resolve(__dirname, '../../../build/test-queue-recovery'); fs.mkdirSync(fixtures, { recursive: true });
const cwd = fs.mkdtempSync(path.join(fixtures, 'workspace-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true, getWorkspaceFolder: () => ({}) } };
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
const { DshPanelView } = require('../src/panel/view'); Module._load = originalLoad;
function storage(initial) {
  const values = new Map(initial ? [[QUEUE_KEY, structuredClone(initial)]] : []), gates = [], writes = [];
  return { values, gates, writes, get: key => values.get(key), async update(key, value) {
    writes.push(structuredClone(value)); if (gates.length) await gates.shift().promise;
    if (this.fail || this.failAt === writes.length) throw new Error('disk unavailable'); values.set(key, structuredClone(value));
  } };
}
function panelFor(state) {
  const panel = new DshPanelView({ extensionUri: {}, workspaceState: state, log() {}, kernels: { release() {}, acquire() {}, live() {} } });
  const output = [], calls = [], client = new EventEmitter(); client.isConnected = true;
  const session = { sessionId: 'session', cwd, client, busy: true };
  panel.view = {}; panel.post = value => output.push(structuredClone(value)); panel.workdir = () => cwd;
  panel.session = session; panel.client = client; panel.connections.client = client; panel.connections.status = { instanceId: 'instance' };
  panel.ensureConnection = async () => session; panel.send = async text => { calls.push(text); return { stopReason: 'end_turn' }; };
  return { panel, session, output, calls };
}
async function idle(panel) { for (let i = 0; i < 80; i++) { await tick(); if (!panel.queue.active && !panel.queue.items.length) return; } throw new Error('queue did not finish'); }
async function confirmEdit(current, id, overrides = {}) {
  const reply = current.output.findLast(item => item.type === 'queueEdit' && item.phase === 'prepared' && item.id === id);
  assert(reply, 'The original entry is prepared before confirming its durable draft');
  await current.panel.queueAction({ action: 'confirmEdit', id, token: reply.token,
    draft: { version: 1, cwd: reply.cwd, savedAt: Date.now(), text: reply.text, attachments: reply.attachments }, ...overrides });
}

(async () => { try {
  const state = storage(), acceptance = deferred(), startup = deferred(); state.gates.push(acceptance, startup);
  const current = panelFor(state); current.session.busy = false;
  const completion = deferred(); current.panel.send = async text => { current.calls.push(text); await completion.promise; return { stopReason: 'end_turn' }; };
  const accepting = current.panel.acceptMessage({ requestId: 'accepted-once', text: 'persist me' });
  await tick(); assert.equal(current.output.some(item => item.phase === 'accepted'), false); assert.equal(state.get(QUEUE_KEY), undefined);
  acceptance.resolve(); assert.equal(await accepting, true); await tick();
  assert.equal(current.output.filter(item => item.phase === 'accepted').length, 1); assert.deepEqual(current.calls, []);
  assert.equal(state.get(QUEUE_KEY).items[0].phase, 'waiting');
  const waitingRecord = structuredClone(state.get(QUEUE_KEY));
  const waiting = panelFor(storage(waitingRecord)); assert(waiting.panel.queue.paused); assert.equal(waiting.panel.queue.items[0].text, 'persist me');
  assert.equal(await waiting.panel.acceptMessage({ requestId: 'accepted-once', text: 'persist me' }), true);
  assert.equal(waiting.panel.queue.items.length, 1, 'Restoring and retrying an accepted request never creates another entry');
  assert.deepEqual(waiting.calls, []);
  startup.resolve(); for (let i = 0; i < 10 && !current.calls.length; i++) await tick();
  assert.deepEqual(current.calls, ['persist me']); assert.equal(state.get(QUEUE_KEY).items[0].phase, 'running');
  const unknown = panelFor(storage(state.get(QUEUE_KEY))); assert(unknown.panel.queue.paused); assert(unknown.panel.queue.items[0].uncertain);
  await assert.rejects(unknown.panel.queueAction({ action: 'continue' }), /执行结果待确认/); assert.deepEqual(unknown.calls, []);
  completion.resolve(); await idle(current.panel);
  assert.equal(state.get(QUEUE_KEY).items.length, 0);

  const brokenState = storage(); brokenState.fail = true; const broken = panelFor(brokenState);
  assert.equal(await broken.panel.acceptMessage({ requestId: 'failed', text: 'keep input' }), false);
  assert(!broken.output.some(item => item.phase === 'accepted')); assert.equal(broken.panel.queue.items.length, 0); assert.deepEqual(broken.calls, []);
  brokenState.fail = false;
  assert.equal(await broken.panel.acceptMessage({ requestId: 'failed', text: 'keep input' }), true);
  assert.equal(broken.panel.queue.items[0].text, 'keep input', 'Failed acceptance can be retried');
  brokenState.fail = true;
  const brokenId = broken.panel.queue.items[0].id;
  await broken.panel.queueAction({ action: 'edit', id: brokenId });
  await confirmEdit(broken, brokenId);
  assert.equal(broken.panel.queue.items.length, 1); assert(broken.output.some(item => item.type === 'queueEdit' && item.error));

  const duplicateState = storage(), duplicate = panelFor(duplicateState), removalGate = deferred();
  await duplicate.panel.acceptMessage({ requestId: 'removed-once', text: 'remove exactly once' });
  const duplicateId = duplicate.panel.queue.items[0].id;
  duplicateState.gates.push(removalGate); duplicateState.failAt = 3;
  const firstRemoval = duplicate.panel.queueAction({ action: 'remove', id: duplicateId });
  const duplicateRemoval = duplicate.panel.queueAction({ action: 'remove', id: duplicateId });
  const duplicateRejected = assert.rejects(duplicateRemoval, /此消息已不在队列中/);
  await tick(); removalGate.resolve(); await Promise.all([firstRemoval, duplicateRejected]);
  assert.equal(duplicateState.writes.length, 2, 'A stale second removal never saves or rolls a removed entry back into the queue');
  assert.equal(duplicate.panel.queue.items.length, 0); assert.equal(duplicateState.get(QUEUE_KEY).items.length, 0);

  const transferState = storage(), transfer = panelFor(transferState);
  await transfer.panel.acceptMessage({ requestId: 'handoff', text: 'durably transferred' });
  const transferId = transfer.panel.queue.items[0].id;
  await Promise.all([transfer.panel.queueAction({ action: 'edit', id: transferId }), transfer.panel.queueAction({ action: 'edit', id: transferId })]);
  const prepares = transfer.output.filter(item => item.phase === 'prepared');
  assert.equal(prepares.length, 2); assert.equal(prepares[0].token, prepares[1].token);
  assert.equal(transfer.panel.queue.items.length, 1); assert.equal(transferState.get(QUEUE_KEY).items.length, 1);
  await assert.rejects(transfer.panel.queueAction({ action: 'continue' }), /取回消息/);
  await confirmEdit(transfer, transferId, { token: 'stale-token' });
  assert.equal(transfer.panel.queue.items.length, 1); assert.equal(transfer.panel.pendingQueueEdits.size, 1);
  await confirmEdit(transfer, transferId);
  assert.equal(transfer.panel.queue.items.length, 0); assert.equal(transferState.get(QUEUE_KEY).items.length, 0);
  assert.equal(transferState.get(draftKey(cwd)).text, 'durably transferred');
  await confirmEdit(transfer, transferId);
  assert.equal(transfer.panel.queue.items.length, 0, 'A repeated acknowledgement never resurrects the removed message');

  for (const closingStage of ['prepared', 'draft-save', 'queue-save']) {
    const closeState = storage(), closing = panelFor(closeState);
    await closing.panel.acceptMessage({ requestId: closingStage, text: 'retained on view close' });
    const id = closing.panel.queue.items[0].id;
    await closing.panel.queueAction({ action: 'edit', id });
    if (closingStage === 'prepared') {
      closing.panel.view = undefined;
      await confirmEdit(closing, id);
    } else {
      const held = deferred();
      if (closingStage === 'queue-save') closeState.gates.push({ promise: Promise.resolve() });
      closeState.gates.push(held);
      const finishing = confirmEdit(closing, id); await tick(); closing.panel.view = undefined; held.resolve(); await finishing;
    }
    const queued = closeState.get(QUEUE_KEY).items;
    const savedDraft = closeState.get(draftKey(cwd));
    assert(queued.some(item => item.text === 'retained on view close') || savedDraft?.text === 'retained on view close', closingStage + ': either the original queue or its durable draft survives');
    if (closingStage !== 'queue-save') assert.equal(queued.length, 1, 'A vanished view cannot acknowledge a handoff');
    else assert.equal(savedDraft.text, 'retained on view close', 'The draft is durable before the queue entry can be removed');
  }

  const rollbackState = storage(), rollback = panelFor(rollbackState);
  await rollback.panel.acceptMessage({ requestId: 'rollback', text: 'draft saved but queue write fails' });
  const rollbackId = rollback.panel.queue.items[0].id; rollbackState.failAt = 3;
  await rollback.panel.queueAction({ action: 'edit', id: rollbackId }); await confirmEdit(rollback, rollbackId);
  assert.equal(rollback.panel.queue.items.length, 1); assert.equal(rollbackState.get(QUEUE_KEY).items.length, 1);
  assert.equal(rollbackState.get(draftKey(cwd)).text, 'draft saved but queue write fails');
  rollbackState.failAt = undefined;
  await rollback.panel.queueAction({ action: 'edit', id: rollbackId }); await confirmEdit(rollback, rollbackId);
  assert.equal(rollback.panel.queue.items.length, 0);

  const incomplete = panelFor(storage());
  await incomplete.panel.acceptMessage({ requestId: 'incomplete', text: 'original body' });
  const incompleteId = incomplete.panel.queue.items[0].id;
  await incomplete.panel.queueAction({ action: 'edit', id: incompleteId });
  await confirmEdit(incomplete, incompleteId, { draft: { version: 1, cwd, savedAt: Date.now(), text: 'different content', attachments: [] } });
  assert.equal(incomplete.panel.queue.items.length, 1, 'A draft which does not contain the original cannot acknowledge its removal');

  const needsStart = storage(); const start = panelFor(needsStart); await start.panel.acceptMessage({ requestId: 'startup', text: 'not started' });
  needsStart.fail = true; start.session.busy = false; await start.panel.drainQueue();
  assert.deepEqual(start.calls, []); assert(start.panel.queue.paused); assert.equal(start.panel.queue.items.length, 1);
  needsStart.fail = false; await start.panel.queueAction({ action: 'continue' }); await idle(start.panel); assert.deepEqual(start.calls, ['not started']);

  for (const cause of ['stop', 'pause', 'cwd', 'stop-storage-failure', 'stop-requeue-save-failure']) {
    const pausedState = storage(), held = panelFor(pausedState), starting = deferred();
    held.panel.send = DshPanelView.prototype.send;
    held.session.stop = () => {};
    held.session.send = async text => { held.calls.push(text); return { stopReason: 'end_turn' }; };
    await held.panel.acceptMessage({ requestId: 'held-' + cause, text: 'held ' + cause });
    pausedState.gates.push(starting); held.session.busy = false;
    const draining = held.panel.drainQueue(); await tick(); assert(held.panel.queue.active, cause);
    if (cause.startsWith('stop')) await held.panel.onWebviewMessage({ type: 'stop' });
    else if (cause === 'pause') held.panel.pauseQueue('explicit pause');
    else held.panel.workdir = () => path.dirname(cwd);
    if (cause === 'stop-storage-failure') pausedState.fail = true;
    if (cause === 'stop-requeue-save-failure') pausedState.failAt = 3;
    starting.resolve(); await draining;
    assert.deepEqual(held.calls, [], cause + ': stopping or changing scope during running persistence must not send');
    assert.equal(held.panel.queue.active, undefined); assert.equal(held.panel.queue.items.length, 1); assert(held.panel.queue.paused);
    assert.equal(pausedState.get(QUEUE_KEY).items[0].phase, cause === 'stop-requeue-save-failure' ? 'running' : 'waiting');
    if (cause === 'stop-requeue-save-failure') assert(normalizeQueue(pausedState.get(QUEUE_KEY)).items[0].uncertain, 'A failed rollback save remains conservative across reload');
    held.panel.workdir = () => cwd; pausedState.fail = false; pausedState.failAt = undefined;
    await held.panel.queueAction({ action: 'continue' }); await idle(held.panel);
    assert.deepEqual(held.calls, ['held ' + cause], cause + ': an explicit retry sends the retained entry only once');
  }

  for (const cause of ['stop', 'cwd', 'session']) {
    const scopedState = storage(), scoped = panelFor(scopedState), removal = deferred();
    scoped.panel.send = DshPanelView.prototype.send; scoped.session.stop = () => {};
    scoped.session.send = async text => { scoped.calls.push(text); return { stopReason: 'end_turn' }; };
    await scoped.panel.acceptMessage({ requestId: 'seed-' + cause, text: 'seed' });
    scopedState.gates.push(removal);
    const removing = scoped.panel.queueAction({ action: 'remove', id: scoped.panel.queue.items[0].id });
    await tick(); assert.equal(scoped.panel.queue.items.length, 0);
    scoped.session.busy = false;
    const accepting = scoped.panel.acceptMessage({ requestId: 'scope-' + cause, text: 'must remain in input' });
    await tick();
    if (cause === 'stop') await scoped.panel.onWebviewMessage({ type: 'stop' });
    else if (cause === 'cwd') scoped.panel.workdir = () => path.dirname(cwd);
    else scoped.session.sessionId = 'replacement';
    removal.resolve(); await removing;
    assert.equal(await accepting, false, cause + ': a scope change before serialized admission must reject the unaccepted input');
    await tick(); assert.deepEqual(scoped.calls, []); assert.equal(scoped.panel.queue.items.length, 0);
    assert(scoped.output.some(item => item.type === 'sendResult' && item.requestId === 'scope-' + cause && item.phase === 'rejected'));
  }

  const interruptedState = storage(), interrupted = panelFor(interruptedState); interrupted.session.busy = false;
  interrupted.panel.send = async () => { interrupted.panel.client.isConnected = false; throw Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }); };
  assert.equal(await interrupted.panel.acceptMessage({ requestId: 'interrupted', text: 'unknown result' }), true);
  for (let i = 0; i < 20; i++) await tick();
  assert(interrupted.panel.queue.items[0].uncertain); assert.equal(interruptedState.get(QUEUE_KEY).items[0].phase, 'uncertain');
  const interruptedReload = panelFor(storage(interruptedState.get(QUEUE_KEY)));
  await assert.rejects(interruptedReload.panel.queueAction({ action: 'continue' }), /执行结果待确认/);
  assert.deepEqual(interruptedReload.calls, []);

  const timedOutState = storage(), timedOut = panelFor(timedOutState); timedOut.session.busy = false;
  timedOut.panel.send = DshPanelView.prototype.send;
  timedOut.session.send = async () => { timedOut.calls.push('attempted'); throw new DoorTimeoutError('session/prompt', 10000, '取消请求'); };
  assert.equal(await timedOut.panel.acceptMessage({ requestId: 'cancel-timeout', text: 'unknown cancellation result' }), true);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(timedOut.panel.client.isConnected, true); assert(timedOut.panel.queue.items[0].uncertain, 'A cancellation timeout is unknown even while the socket remains connected');
  assert(!timedOut.panel.queue.reason.includes('连接中断'), 'An unknown result does not imply the connected transport has disconnected');
  assert.equal(timedOutState.get(QUEUE_KEY).items[0].phase, 'uncertain');
  await assert.rejects(timedOut.panel.queueAction({ action: 'continue' }), /执行结果待确认/); assert.deepEqual(timedOut.calls, ['attempted']);

  const trusted = panelFor(storage(waitingRecord)); trusted.session.busy = false; vscode.workspace.isTrusted = false;
  await assert.rejects(trusted.panel.queueAction({ action: 'continue' }), /受信任/); assert.deepEqual(trusted.calls, []); vscode.workspace.isTrusted = true;
  const getFolder = vscode.workspace.getWorkspaceFolder; vscode.workspace.getWorkspaceFolder = () => undefined;
  await assert.rejects(trusted.panel.queueAction({ action: 'continue' }), /目录/); vscode.workspace.getWorkspaceFolder = getFolder;
  trusted.panel.workdir = () => path.dirname(cwd); await assert.rejects(trusted.panel.queueAction({ action: 'continue' }), /原会话或目录/); trusted.panel.workdir = () => cwd;
  await trusted.panel.queueAction({ action: 'continue' }); await idle(trusted.panel); assert.deepEqual(trusted.calls, ['persist me']);

  for (const invalid of [{}, { ...waitingRecord, version: 99 }, { ...waitingRecord, savedAt: Date.now() - QUEUE_TTL - 1 },
    { ...waitingRecord, items: [...waitingRecord.items, ...waitingRecord.items] }, { ...waitingRecord, extra: 'x'.repeat(QUEUE_BYTES) }]) assert.throws(() => normalizeQueue(invalid), /损坏或已过期/);
  const corruptState = storage({ version: 999 }), corrupt = panelFor(corruptState);
  assert(corrupt.panel.queue.state().recoveryBlocked); assert.equal(await corrupt.panel.acceptMessage({ requestId: 'blocked', text: 'do not overwrite' }), false);
  assert.deepEqual(corruptState.get(QUEUE_KEY), { version: 999 });
  await corrupt.panel.queueAction({ action: 'discardRecovery' }); assert.equal(corruptState.get(QUEUE_KEY), undefined); assert(!corrupt.panel.queue.recoveryBlocked);

  const ordered = storage(), first = deferred(); ordered.gates.push(first);
  const store = new QueuePersistence(ordered), queue = new MessageQueue();
  queue.add(snapshotMessage('one'), { cwd, sessionId: 'session' }, 'one'); const older = store.save(queue);
  queue.add(snapshotMessage('two'), { cwd, sessionId: 'session' }, 'two'); const newer = store.save(queue);
  await tick(); assert.equal(ordered.writes.length, 1); first.resolve(); await Promise.all([older, newer]);
  assert.deepEqual(ordered.get(QUEUE_KEY).items.map(item => item.text), ['one', 'two']);
  console.log('Persistent queue: accepted/start boundaries, interrupted reloads, uncertainty, paused restore, deduplication, storage failures, retries, scope/trust checks, corruption, budgets and write ordering passed');
} finally { fs.rmSync(cwd, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
