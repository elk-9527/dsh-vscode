'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { referenceAttachments, filterSkillGroups } = require('../src/chat/context');
const { buildPromptBlocks } = require('../src/dsh/blocks');
const { historyOptions, historyPage } = require('../src/dsh/history-query');
const { historyMarkdown } = require('../src/dsh/history-export');
const { ReviewFixes, parseEdits, replacement } = require('../src/bridge/fixes');
const { repositorySnapshot } = require('../src/bridge/results');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-features-'));
const cwd = fs.realpathSync(root), file = path.join(cwd, 'sample.js');
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => 'file:' + file });
const disposable = { dispose() {} };
(async () => {
  const original = 'export function sum(a, b) { return a - b; }\n';
  fs.writeFileSync(file, original);
  let text = original, dirty = false, saved = 0, permission, prompts = 0, apiClosed = 0;
  const document = { uri: uri(file), fileName: file, languageId: 'javascript', lineCount: 2,
    get isDirty() { return dirty; }, getText: range => range ? text.slice(range.start.offset, range.end.offset) : text,
    validateRange: range => ({ isEqual: value => value === range }), positionAt: offset => ({ offset }),
    save: async () => { fs.writeFileSync(file, text); dirty = false; saved++; return true; } };
  const workspace = { isTrusted: true, getWorkspaceFolder: item => item.fsPath.startsWith(cwd) ? { uri: uri(cwd) } : undefined,
    openTextDocument: async () => document };
  const vscode = { workspace };
  dirty = true; text = 'unsaved editor text\n';
  const attachments = await referenceAttachments(vscode, [{ value: uri(file) }, { value: uri(file) }], cwd);
  assert.equal(attachments.length, 1); assert.equal(attachments[0].text, text); assert.equal(attachments[0].uri, undefined);
  assert(buildPromptBlocks('Question', attachments)[0].text.includes('unsaved editor text'));
  const range = { start: { line: 0, character: 0, offset: 0 }, end: { line: 0, character: 7, offset: 7 } };
  const selected = await referenceAttachments(vscode, [{ value: { uri: uri(file), range } }], cwd);
  assert.equal(selected[0].kind, 'selection'); assert.equal(selected[0].text, 'unsaved');
  const untitled = { scheme: 'untitled', path: 'Untitled-1', toString: () => 'untitled:Untitled-1' };
  assert.equal((await referenceAttachments(vscode, [{ value: untitled }], cwd))[0].kind, 'content');
  workspace.isTrusted = false; await assert.rejects(referenceAttachments(vscode, [{ value: uri(file) }], cwd)); workspace.isTrusted = true;
  const openDocument = workspace.openTextDocument;
  workspace.openTextDocument = async () => { workspace.isTrusted = false; return document; };
  await assert.rejects(referenceAttachments(vscode, [{ value: uri(file) }], cwd), /受信任/);
  workspace.isTrusted = true; workspace.openTextDocument = openDocument;
  const abortedDuringRead = { aborted: false };
  workspace.openTextDocument = async () => { abortedDuringRead.aborted = true; return document; };
  await assert.rejects(referenceAttachments(vscode, [{ value: uri(file) }], cwd, abortedDuringRead), error => error.code === -32800);
  workspace.openTextDocument = openDocument;
  await assert.rejects(referenceAttachments(vscode, [{ value: uri(path.join(os.tmpdir(), 'outside.js')) }], cwd));
  await assert.rejects(referenceAttachments(vscode, [{ value: uri(file) }], cwd, { aborted: true }), error => error.code === -32800);
  text = '界'.repeat(90000); await assert.rejects(referenceAttachments(vscode, [{ value: uri(file) }], cwd), /256 KiB/);
  text = original; dirty = false;
  assert.equal(filterSkillGroups([{ title: 'Skills', skills: [{ name: 'rust', description: 'Rust tools' }, { name: 'python' }] }], 'RUST')[0].skills.length, 1);

  const cards = Array.from({ length: 205 }, (_, i) => ({ id: 'session-' + i, title: i === 204 ? 'needle old conversation' : 'other', cwd: i % 2 ? path.join(cwd, 'other') : cwd }));
  assert.equal(historyPage(cards, historyOptions({ offset: 200 })).sessions.length, 5);
  assert.equal(historyPage(cards, historyOptions({ query: 'needle' })).sessions[0].id, 'session-204');
  assert.equal(historyPage(cards, historyOptions({ cwd })).total, 103);
  const { createSessionQueryHistory } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/kernel/history.js')));
  const handler = createSessionQueryHistory({ listSessions: async () => cards.map(card => ({ header: { ...card, version: 4 } })),
    readSession: async id => ({ session: cards.find(card => card.id === id), events: [] }),
    readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: cards.find(card => card.id === id), title: { title: cards.find(card => card.id === id).title } } })) });
  assert.equal((await handler.list({ query: 'needle' })).sessions[0].id, 'session-204');
  assert.equal((await handler.list({ offset: 100, limit: 100 })).nextOffset, 200);
  assert.equal((await handler.list({ cwd, query: 'needle' })).total, 1);
  const historyRoot = path.join(cwd, 'history');
  for (let i = 0; i < 105; i++) {
    const folder = path.join(historyRoot, 'group', 'session-' + i); fs.mkdirSync(folder, { recursive: true });
    const events = [{ type: 'session', version: 3, id: 'session-' + i, cwd }, { type: 'session/title', time: i, data: { title: i === 0 ? 'oldest needle' : 'other' } }];
    const target = path.join(folder, 'session.v3.jsonl.zstd'); fs.writeFileSync(target, zlib.zstdCompressSync(events.map(item => JSON.stringify(item)).join('\n'))); fs.utimesSync(target, i + 1, i + 1);
  }
  const extensionHistory = require('../src/dsh/sessions'), doorHistory = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/sessions.js')));
  for (const options of [{ offset: 100 }, { query: 'needle' }, { cwd, limit: 20, offset: 80 }]) assert.deepEqual(extensionHistory.listSessions(historyRoot, options), doorHistory.listSessions(historyRoot, options));
  assert.equal(extensionHistory.listSessions(historyRoot, { query: 'needle' }).sessions[0].id, 'session-0');
  const exported = historyMarkdown({ card: { id: 'one', title: 'Export' }, entries: [{ kind: 'user', text: 'Question' }, { kind: 'assistant', text: 'Answer', thinking: 'Reason' }, { kind: 'tool', tool: { content: '```' } }], truncated: true });
  assert(exported.includes('Question') && exported.includes('Answer') && exported.includes('Reason') && exported.includes('截断'));

  const edits = parseEdits(JSON.stringify({ edits: [{ before: 'a - b', after: 'a + b', explanation: 'Add' }] }), original);
  assert(replacement(original, edits[0]).text.includes('a + b'));
  assert.throws(() => parseEdits('{"edits":[{"before":"a","after":"b"}]}', 'a a'), /唯一/);
  assert.throws(() => parseEdits('{"edits":[{"before":"abc","after":"x"},{"before":"bc","after":"y"}]}', 'abc'), /重叠/);
  assert.throws(() => parseEdits('not JSON', original));
  assert.throws(() => parseEdits('null', original), /没有可应用/);
  assert.throws(() => parseEdits(undefined, original), /有效 JSON/);
  assert.throws(() => parseEdits(JSON.stringify({ edits: [{ before: 'a - b', after: '\0' }] }), original), /无效替换/);
  for (const args of [['init', '-q'], ['add', 'sample.js'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd, windowsHide: true });
  const snapshot = await repositorySnapshot(cwd), finding = { file: 'sample.js', startLine: 1, title: 'Incorrect sum', body: 'Use addition.' };
  let reviewCalls = 0, approval = false, preview = false;
  Object.assign(vscode, { ProgressLocation: { Notification: 1 }, Uri: { file: uri }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    WorkspaceEdit: class { replace(uri, range, text) { Object.assign(this, { uri, range, text }); } },
    languages: {}, commands: { registerCommand: () => disposable, executeCommand: async command => { assert.equal(command, 'vscode.diff'); preview = true; } },
    window: { showErrorMessage() {}, showQuickPick: async items => items[0], showInformationMessage: async (message, options) => typeof options === 'object' && approval ? '应用此项' : undefined,
      withProgress: async (_options, fn) => fn({}, { onCancellationRequested: () => disposable }) } });
  Object.assign(workspace, { onDidCloseTextDocument: () => disposable, applyEdit: async edit => { text = text.slice(0, edit.range.start.offset) + edit.text + text.slice(edit.range.end.offset); dirty = true; return true; } });
  const op = { id: 'review-one', status: 'completed', cwd, fingerprint: snapshot.fingerprint, result: { findings: [finding] } };
  const views = { operations: new Map([[op.id, op]]), connections: { client: { permissionSet: async (_id, value) => { permission = value; return { currentValue: value }; } } }, document: (_name, content) => ({ content }), reviewRequest: async () => { reviewCalls++; return { id: 'fresh-review' }; } };
  const fixes = new ReviewFixes({ vscode, views, context: { subscriptions: [] } });
  fixes.api = { createSession: async options => { assert.equal(options.preset, 'minimal'); return { sessionId: 'fix-session' }; },
    closeSession: async () => { apiClosed++; }, prompt: async (_handle, prompt, options) => { prompts++; assert(prompt.includes(original.trim())); assert.equal(await options.onPermission({}), undefined); options.onEvent({ type: 'text', delta: JSON.stringify({ edits: [{ before: 'a - b', after: 'a + b' }] }) }); } };
  let finishOpen;
  workspace.openTextDocument = () => new Promise(resolve => { finishOpen = () => resolve(document); });
  const generating = fixes.generate(op.id, 0);
  for (let i = 0; !finishOpen && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(finishOpen, 'Generation reached document loading');
  try { await assert.rejects(fixes.generate(op.id, 0), /正在生成/); }
  finally { finishOpen(); workspace.openTextDocument = openDocument; }
  const planId = await generating;
  assert.equal(permission, 'read-only'); assert(preview); assert.equal(text, original, 'Closing confirmation leaves source unchanged'); assert.equal(saved, 0); assert.equal(apiClosed, 1);
  dirty = true; text += '// user edit\n'; await assert.rejects(fixes.apply(planId), /变化/); text = original; dirty = false;
  workspace.isTrusted = false; await assert.rejects(fixes.apply(planId), /受信任/); workspace.isTrusted = true;
  approval = true; await fixes.apply(planId); assert(text.includes('a + b')); assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(saved, 0);
  fs.writeFileSync(file, text); dirty = false; // 模拟编辑器自动保存已经确认的修改。
  const saveDocument = document.save;
  let finishSave;
  document.save = () => new Promise(resolve => { finishSave = async () => { await saveDocument(); resolve(true); }; });
  const verifying = fixes.verify(planId);
  for (let i = 0; !finishSave && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(finishSave); assert.equal(await fixes.verify(planId), undefined);
  assert.equal(await fixes.apply(planId), undefined);
  await finishSave(); await verifying; document.save = saveDocument;
  assert.equal(saved, 1); assert.equal(reviewCalls, 1); assert(!fixes.plans.has(planId)); assert.equal(prompts, 1);

  text = original; dirty = false; fs.writeFileSync(file, original); approval = false;
  const progress = vscode.window.withProgress;
  vscode.window.withProgress = async (_options, fn) => fn({}, { isCancellationRequested: true, onCancellationRequested: () => disposable });
  await assert.rejects(fixes.generate(op.id, 0), /取消/);
  assert.equal(apiClosed, 1); assert.equal(fixes.pending.size, 0);
  vscode.window.withProgress = progress;
  const setPermission = views.connections.client.permissionSet;
  views.connections.client.permissionSet = async () => ({ currentValue: 'workspace-write' });
  await assert.rejects(fixes.generate(op.id, 0), /只读权限/);
  assert.equal(apiClosed, 2); assert.equal(prompts, 1); assert.equal(fixes.pending.size, 0);
  views.connections.client.permissionSet = setPermission;
  const prompt = fixes.api.prompt;
  fixes.api.prompt = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(fixes.generate(op.id, 0), /provider unavailable/);
  assert.equal(apiClosed, 3); assert.equal(fixes.pending.size, 0); assert.equal(text, original);
  fixes.api.prompt = prompt;
  const stalePlan = await fixes.generate(op.id, 0), info = vscode.window.showInformationMessage;
  vscode.window.showInformationMessage = async (_message, options) => {
    if (options?.modal) { text += '// changed while preview open\n'; dirty = true; return '应用此项'; }
  };
  await assert.rejects(fixes.apply(stalePlan), /变化/);
  assert(!text.includes('a + b')); assert.equal(fs.readFileSync(file, 'utf8'), original);
  vscode.window.showInformationMessage = info; text = original; dirty = false;
  fixes.plans.get(stalePlan).expires = 0;
  await assert.rejects(fixes.apply(stalePlan), /过期/); assert(!fixes.plans.has(stalePlan));
  workspace.openTextDocument = async () => { throw new Error('document unavailable'); };
  await assert.rejects(fixes.generate(op.id, 0), /document unavailable/); assert.equal(fixes.pending.size, 0);
  console.log('Chat reference snapshots/trust revocation/cancellation, legacy/v4 history, export and reviewed fix concurrency/permission/cleanup/stale approval/expiry/verification passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('dsh-features-')) fs.rmSync(root, { recursive: true, force: true });
});
