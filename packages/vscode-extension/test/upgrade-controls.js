'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises');
const os = require('node:os'), path = require('node:path'), zlib = require('node:zlib'), { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { DshSession } = require('../src/dsh/session');
const { modelDiagnostics } = require('../src/dsh/model-diagnostics');
const { describeError } = require('../src/dsh/errors');
const { normalizeDraft, draftKey, TTL, MAX_BYTES } = require('../src/panel/drafts');
const { MessageQueue, snapshotMessage } = require('../src/panel/queue');
const { createReviewBudget } = require('../../../tools/bridge/review-budget.cjs');
const history = require('../src/dsh/sessions');
const { cancelHistoryRequest, runHistoryRequest } = require('../../dsh-door/lib/history-requests.cjs');
const { DoorClient } = require('../src/door/client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-'));
(async () => {
  try {
    const reasoning = { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low', name: '低' }, { value: 'high', name: '高' }] };
    assert.match(modelDiagnostics([reasoning]), /低、 高|低、高/); assert.equal(describeError('模型不支持该思考强度，请调整').kind, 'reasoning');
    assert.match(modelDiagnostics([{ ...reasoning, id: 'thinking', category: 'thought_level' }]), /思考强度：低/);
    const client = new EventEmitter(), calls = [];
    client.setConfigOption = async (...args) => { calls.push(args); return { configOptions: [{ ...reasoning, currentValue: 'low' }] }; };
    const session = new DshSession({ client, log() {} }); session.sessionId = 'test'; session.configOptions = [reasoning];
    await session.setOption('reasoning_effort', 'high'); assert.equal(session.configOptions[0].currentValue, 'low', 'Display the authoritative kernel selection');
    await assert.rejects(session.setOption('reasoning_effort', 'invented'), /清单/); assert.equal(calls.length, 1);
    session.busy = true; await assert.rejects(session.setOption('reasoning_effort', 'low'), /回合/); assert.equal(calls.length, 1); session.dispose();
    const attachment = { kind: 'content', name: 'scratch.js', id: 'scratch', text: 'unsaved', uri: undefined };
    const draft = { version: 1, cwd: root, savedAt: Date.now(), text: 'draft', attachments: [attachment], recovery: { text: 'failed', attachments: [attachment] } };
    assert.equal(normalizeDraft(draft, { cwd: root }).recovery.attachments[0].text, 'unsaved');
    assert.equal(normalizeDraft(draft, { cwd: root, trusted: false }).attachments.length, 0);
    assert.equal(normalizeDraft(draft, { cwd: root, trusted: false }).recovery.attachments.length, 0);
    const multiple = { ...draft, recoveries: [
      { text: 'first unsent', attachments: [attachment] },
      { text: 'second unsent', attachments: [{ ...attachment, text: 'second snapshot' }] },
      { text: 'third unsent', attachments: [] },
    ], recovery: undefined };
    const restored = normalizeDraft(multiple, { cwd: root });
    assert.equal(restored.text, 'draft'); assert.equal(restored.attachments[0].text, 'unsaved');
    assert.deepEqual(restored.recoveries.map(item => item.text), ['first unsent', 'second unsent', 'third unsent']);
    assert.equal(restored.recovery, undefined); assert(restored.recoveries.every(item => item.version === undefined && item.cwd === undefined && item.savedAt === undefined));
    const roundTrip = normalizeDraft(JSON.parse(JSON.stringify(restored)), { cwd: root });
    assert.deepEqual(roundTrip, restored, 'All unsent drafts survive save and restore independently');
    const testEvidence = { kind: 'content', id: 'test:execution-7', scope: 'test', source: 'user-provided',
      turnId: 'turn-3', testId: 'execution-7', name: '测试证据', text: '用户明确提供的日志（未自动核实属于此次执行）：\nAssertion failed' };
    const accepted = snapshotMessage('排查此次执行', [testEvidence]);
    const evidenceDraft = normalizeDraft({ ...draft, attachments: accepted.attachments,
      recovery: undefined, recoveries: [{ text: '原始请求', attachments: accepted.attachments }] }, { cwd: root });
    const evidenceRestored = normalizeDraft(JSON.parse(JSON.stringify(evidenceDraft)), { cwd: root });
    for (const evidence of [accepted.attachments[0], evidenceRestored.attachments[0], evidenceRestored.recoveries[0].attachments[0]]) {
      assert.deepEqual([evidence.source, evidence.turnId, evidence.testId, evidence.scope, evidence.text],
        [testEvidence.source, 'turn-3', 'execution-7', 'test', testEvidence.text], 'Evidence identity and attribution survive acceptance and every restored draft');
    }
    const evidenceQueue = new MessageQueue();
    evidenceQueue.add(snapshotMessage(evidenceRestored.text, evidenceRestored.attachments), { cwd: root, sessionId: 'session-3' }, 'send-7');
    testEvidence.source = 'automatic'; testEvidence.turnId = 'turn-4'; testEvidence.testId = 'execution-8'; testEvidence.text = 'changed outside queue';
    evidenceQueue.take();
    evidenceQueue.finish('执行失败，等待用户处理');
    assert.equal(evidenceQueue.state().items[0].attachments[0].source, 'user-provided');
    assert.equal(evidenceQueue.state().items[0].attachments[0].turnId, 'turn-3');
    assert.equal(evidenceQueue.state().items[0].attachments[0].testId, 'execution-7');
    assert.match(evidenceQueue.state().items[0].attachments[0].text, /未自动核实属于此次执行/);
    assert(Object.isFrozen(evidenceQueue.items[0].attachments[0]), 'Queued evidence remains immutable when the originating result changes');
    const invalidEvidence = snapshotMessage('仍保留正文', [{ ...accepted.attachments[0], source: { untrusted: true }, turnId: 3, testId: null }]).attachments[0];
    assert.equal(invalidEvidence.source, undefined); assert.equal(invalidEvidence.turnId, undefined); assert.equal(invalidEvidence.testId, undefined);
    assert.equal(normalizeDraft(evidenceDraft, { cwd: root, trusted: false }).attachments.length, 0);
    assert.equal(normalizeDraft(evidenceDraft, { cwd: root, trusted: false }).recoveries[0].attachments.length, 0);
    const untrusted = normalizeDraft(multiple, { cwd: root, trusted: false });
    assert.equal(untrusted.text, 'draft'); assert.deepEqual(untrusted.recoveries.map(item => item.text), ['first unsent', 'second unsent', 'third unsent']);
    assert.equal(untrusted.attachments.length, 0); assert(untrusted.recoveries.every(item => item.attachments.length === 0));
    const merged = normalizeDraft({ ...multiple, recoveries: [...multiple.recoveries, { attachments: [{ text: 'unsaved', name: 'scratch.js', kind: 'content', id: 'scratch' }], text: 'first unsent' }], recovery: multiple.recoveries[0] }, { cwd: root });
    assert.equal(merged.recoveries.length, 3); assert.equal(merged.recovery, undefined);
    assert.equal(normalizeDraft({ ...multiple, recovery: { text: 'legacy fourth', attachments: [] } }, { cwd: root }).recoveries.length, 4);
    const sizeable = normalizeDraft({ ...multiple, text: '', attachments: [], recoveries: [{ text: 'large recovery', attachments: [{ ...attachment, text: 'x'.repeat(256 * 1024) }] }] }, { cwd: root });
    assert(sizeable); assert.equal(sizeable.recovery, undefined); assert(Buffer.byteLength(JSON.stringify(sizeable)) < MAX_BYTES, 'A recovery attachment is stored once');
    assert.equal(normalizeDraft({ ...multiple, recoveries: Array.from({ length: 5 }, (_, index) => ({ text: String(index) + 'x'.repeat(110000), attachments: [] })) }, { cwd: root }), undefined, 'Reject the entire oversized draft instead of dropping recovery entries');
    assert.equal(normalizeDraft({ ...multiple, recoveries: [{ text: 'same', attachments: [attachment] }, { text: 'same', attachments: [{ ...attachment, text: 'different' }] }] }, { cwd: root }).recoveries.length, 2, 'Different attachment snapshots remain distinct');
    assert.equal(normalizeDraft({ ...multiple, recoveries: [{ text: 'same', attachments: [attachment] }, { text: 'same', attachments: [{ ...attachment, text: 'different' }] }] }, { cwd: root, trusted: false }).recoveries.length, 1, 'Deduplicate after removing untrusted attachment contents');
    assert.equal(normalizeDraft(multiple, { cwd: root, now: draft.savedAt + TTL + 1 }), undefined);
    assert.equal(normalizeDraft({ ...multiple, recoveries: [{ text: 'valid', attachments: [] }, { text: 'invalid\0', attachments: [] }] }, { cwd: root }), undefined);
    assert.equal(normalizeDraft(draft, { cwd: root + 'other' }), undefined);
    if (process.platform === 'win32') {
      const alias = root.toUpperCase().replaceAll('\\', '/');
      assert.equal(normalizeDraft({ ...draft, cwd: alias }, { cwd: root })?.text, 'draft', 'Restore the same Windows workspace after drive casing changes');
      assert.equal(draftKey(alias), draftKey(root), 'Equivalent Windows paths share a draft key');
    } else {
      assert.equal(normalizeDraft({ ...draft, cwd: root.toUpperCase() }, { cwd: root }), undefined, 'Keep distinct case-sensitive workspaces separate');
    }
    assert.equal(normalizeDraft(draft, { cwd: root, now: draft.savedAt + TTL + 1 }), undefined);
    assert.equal(normalizeDraft({ ...draft, attachments: [{ ...attachment, text: 'x'.repeat(600000) }] }, { cwd: root }), undefined);
    const events = [], controller = new AbortController();
    const budget = createReviewBudget({ signal: controller.signal, emit: item => events.push(item), maxCalls: 2, mode: 'worktree' });
    assert.equal(budget.record(), undefined); assert.equal(budget.record(), undefined); assert.match(budget.record(), /预算/);
    assert(budget.signal.aborted); assert.match(events.at(-1).message, /未完成/); assert.match(budget.scope, /git diff HEAD/); budget.dispose();
    const timed = createReviewBudget({ timeoutMs: 15 }); await new Promise(resolve => setTimeout(resolve, 25)); assert(timed.signal.aborted); timed.dispose();
    const cancelled = createReviewBudget({ signal: controller.signal }); controller.abort(); assert(cancelled.signal.aborted); cancelled.dispose();
    const responses = [], waiting = [], state = { respond: item => responses.push(item), sessionsHandler: { list: ({ signal }) => { waiting.push(signal); return new Promise(() => {}); } } };
    const pendingRead = runHistoryRequest({ id: 1, method: 'dsh-door/sessions/list', params: { signal: 'untrusted' } }, 'list', state);
    await Promise.resolve();
    assert.equal(cancelHistoryRequest({ method: '$/cancelRequest', params: { id: 1 } }, {}), false, 'Cancellation stays within the owning connection');
    await runHistoryRequest({ id: 1, method: 'dsh-door/sessions/list' }, 'list', state); assert.equal(responses.at(-1).error.code, -32600, 'Reject concurrent duplicate ids');
    assert(cancelHistoryRequest({ method: '$/cancelRequest', params: { id: 1 } }, state)); await pendingRead;
    assert(waiting[0].aborted); assert.equal(responses.at(-1).error.code, -32800); assert.equal(state.historyReads.size, 0, 'An uncancellable host read must not hold the request slot');
    responses.length = 0;
    const flood = Array.from({ length: 8 }, (_, id) => runHistoryRequest({ id: id + 2, method: 'dsh-door/sessions/list' }, 'list', state));
    await runHistoryRequest({ id: 10, method: 'dsh-door/sessions/list' }, 'list', state); assert.equal(responses.at(-1).error.code, -32000);
    state.historyClosed = true; for (const item of state.historyReads.values()) item.abort(); await Promise.all(flood);
    assert.equal(state.historyReads.size, 0); assert.equal(responses.length, 1, 'Disconnect stops replies and frees all pending slots');
    const completed = { respond: item => responses.push(item), sessionsHandler: { get: async (id, { signal }) => { assert(signal instanceof AbortSignal); return { id }; } } };
    await runHistoryRequest({ id: 20, method: 'dsh-door/sessions/get', params: { id: 'session' } }, 'get', completed); assert.equal(responses.at(-1).result.id, 'session'); assert.equal(completed.historyReads.size, 0);
    await runHistoryRequest({ id: 21, method: 'dsh-door/sessions/constructor' }, 'constructor', completed); assert.equal(responses.at(-1).error.code, -32601);
    // Exercise the actual client's frames without requiring host TCP access.
    const net = require('node:net'), originalConnect = net.connect, wire = [], socket = new EventEmitter();
    socket.destroyed = false; socket.setNoDelay = () => {}; socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    const channel = { respond: value => socket.emit('data', Buffer.from(JSON.stringify(value) + '\n')), sessionsHandler: { list: () => new Promise(() => {}) } };
    socket.write = data => { const frame = JSON.parse(String(data)); wire.push(frame); queueMicrotask(() => {
      if (frame.method === 'initialize') channel.respond({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
      else if (frame.method === 'dsh-door/sessions/list') void runHistoryRequest(frame, 'list', channel);
      else cancelHistoryRequest(frame, channel);
    }); return true; };
    net.connect = () => { queueMicrotask(() => socket.emit('connect')); return socket; };
    const transport = new DoorClient({ host: '127.0.0.1', port: 1 });
    try {
      await transport.connect(); const stop = new AbortController(); const read = transport.listHistory({ query: 'cancel', signal: stop.signal });
      await Promise.resolve(); stop.abort(); await assert.rejects(read, error => error.code === -32800);
      assert.equal(channel.historyReads.size, 0); assert.equal(wire[1].params.signal, undefined);
      assert.equal(wire[2].method, '$/cancel_request'); assert.equal(wire[2].params.requestId, wire[1].id);
    } finally { transport.close(); net.connect = originalConnect; }
    const dir = path.join(root, 'sessions', 'group'); fs.mkdirSync(dir, { recursive: true });
    const write = (id, title, group = dir) => { const folder = path.join(group, id); fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, history.SESSION_FILE);
      fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from([{ type: 'session', id, cwd: root }, { type: 'session/title', data: { title } }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(64000) }] } }].map(item => JSON.stringify(item)).join('\n')))); return file; };
    for (let i = 0; i < 150; i++) write(`s-${i}`, `Title ${i}`);
    const sessionsRoot = path.dirname(dir); let reads = 0, turns = 0;
    const oldRead = fsp.readFile; fsp.readFile = async (...args) => { reads++; return oldRead(...args); };
    const pulse = setInterval(() => turns++, 1);
    try {
      let result = await history.listSessionsAsync(sessionsRoot, { query: 'Title', limit: 500 }); assert.equal(result.total, 150); assert.equal(reads, 150); assert(turns > 0, 'Allow other work while decoding');
      result.sessions[0].title = 'changed by caller'; reads = 0;
      result = await history.listSessionsAsync(sessionsRoot, { query: 'Title', limit: 500 }); assert.equal(reads, 0, 'Reuse summaries without rereading message bodies'); assert.equal(result.total, 150);
      write('s-0', 'Changed title'); reads = 0; result = await history.listSessionsAsync(sessionsRoot, { query: 'Changed' }); assert.equal(result.total, 1); assert.equal(reads, 1);
      fs.unlinkSync(path.join(dir, 's-0', history.SESSION_FILE)); result = await history.listSessionsAsync(sessionsRoot, { query: 'Changed' }); assert.equal(result.total, 0);
      const aborted = new AbortController(); const pending = history.listSessionsAsync(sessionsRoot, { query: 'Title', signal: aborted.signal }); aborted.abort(); await assert.rejects(pending, /abort/i);
      const other = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/sessions.js')).href);
      assert.deepEqual(await other.listSessionsAsync(sessionsRoot, { query: 'Title', limit: 10 }), await history.listSessionsAsync(sessionsRoot, { query: 'Title', limit: 10 }));
      assert.deepEqual(await other.getSessionAsync(sessionsRoot, 's-1'), await history.getSessionAsync(sessionsRoot, 's-1'));
      const concurrentRoot = path.join(root, 'concurrent');
      for (let i = 0; i < 4; i++) write(`c-${i}`, `Concurrent ${i} ` + 'x'.repeat(400000), path.join(concurrentRoot, 'group'));
      const searches = await Promise.all(Array.from({ length: 8 }, () => history.listSessionsAsync(concurrentRoot, { query: 'Concurrent' })));
      assert(searches.every(item => item.total === 4)); reads = 0;
      assert.equal((await history.listSessionsAsync(concurrentRoot, { query: 'Concurrent' })).total, 4);
      assert.equal(reads, 0, 'Concurrent searches must not count the same cached summary repeatedly');
    } finally { fsp.readFile = oldRead; clearInterval(pulse); }
    assert.equal(fs.readFileSync(path.resolve(__dirname, '../src/dsh/sessions-async.cjs'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../../dsh-door/lib/sessions-async.cjs'), 'utf8'));
    console.log('PASS model selection, draft boundaries, review budgets, cached history, invalidation, cancellation, disconnect and request limits');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
