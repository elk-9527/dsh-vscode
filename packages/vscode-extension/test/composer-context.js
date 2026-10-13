'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { ComposerContext, fileGlob, matches } = require('../src/panel/completions');
const { buildPromptBlocks } = require('../src/dsh/blocks');
const { normalizeDraft } = require('../src/panel/drafts');
const { snapshotMessage, MessageQueue } = require('../src/panel/queue');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-composer-'));
const cwd = path.join(root, 'project'), outside = path.join(root, 'outside');
fs.mkdirSync(cwd); fs.mkdirSync(outside);
const file = path.join(cwd, 'space 文件.js'); fs.writeFileSync(file, 'saved');
const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => 'file:' + fsPath });
let currentCwd = cwd, text = 'unsaved', finds = 0, calls = [], cancelled = false;
const range = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
const doc = { uri: uri(file), fileName: file, isDirty: true, languageId: 'javascript', lineCount: 1, version: 1,
  getText: value => value ? text.slice(0, 3) : text, validateRange: () => ({ isEqual: () => true }) };
const vscode = { Uri: { file: uri }, RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
  CancellationTokenSource: class { constructor() { this.token = {}; } cancel() { cancelled = true; } dispose() {} },
  workspace: { isTrusted: true, getWorkspaceFolder: value => value.fsPath === cwd || value.fsPath.startsWith(cwd + path.sep) ? { uri: uri(cwd) } : undefined,
    findFiles: async pattern => { finds++; assert.equal(pattern.baseUri.fsPath, cwd); return [uri(file)]; }, openTextDocument: async () => doc },
  window: { activeTextEditor: { document: doc, selection: range } } };
const invoke = async (id, input, context) => { calls.push({ id, input, context }); return { value: id.endsWith('.list') ? { groups: [{ title: '项目技能', skills: [{ id: 'one', name: 'code-review', description: '审查代码' }] }] } : { content: 'Review instructions' } }; };
const composer = new ComposerContext({ vscode, workdir: () => currentCwd, invoke });
(async () => {
  let list = await composer.query('@', 'space 文件'); assert.equal(list.items.length, 1); assert.equal(list.items[0].label, 'space 文件.js');
  assert.equal(calls.length, 0, 'File search must not invoke skills or a model');
  const old = list.items[0].id, item = await composer.select(old);
  assert.equal(item.text, 'unsaved'); assert.equal(item.uri, undefined); assert.equal(item.kind, 'content');
  list = await composer.query('#', ''); assert.deepEqual(list.items.map(item => item.label), ['当前文件', '当前选区', 'space 文件.js']);
  assert.equal((await composer.select(list.items[1].id)).text, 'uns');
  doc.version++; await assert.rejects(composer.select(list.items[1].id), /选区已变化/);
  await assert.rejects(composer.select(old), /过期/);
  list = await composer.query('/', 'review'); assert.equal(list.items.find(item => item.kind === 'skill').label, 'code-review');
  await composer.query('/', '审查'); assert.equal(calls.length, 1, 'Typing reuses the same short lived skills scan');
  list = await composer.query('/', ''); const skill = await composer.select(list.items.find(item => item.kind === 'skill').id);
  assert.equal(calls.at(-1).id, 'linxin.skill-explorer.read'); assert.equal(calls.at(-1).context.cwd, cwd);
  assert.equal(skill.kind, 'skill'); assert.equal(skill.text, 'Review instructions');
  assert(buildPromptBlocks('Please review', [skill])[0].text.includes('Review instructions'));
  assert.equal(normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: 'draft', attachments: [skill] }, { cwd }).attachments[0].kind, 'skill');
  assert.equal(calls.filter(call => !/\.(list|read)$/.test(call.id)).length, 0);
  const originalLoad = Module._load;
  let DshPanelView;
  try { Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); }; ({ DshPanelView } = require('../src/panel/view')); }
  finally { Module._load = originalLoad; }
  await assert.rejects(DshPanelView.prototype.send.call({}, 'Question', Array(21).fill({ kind: 'content', text: 'x' })), /20 项/);
  await assert.rejects(DshPanelView.prototype.send.call({}, 'Question', [{ kind: 'content', text: 'x'.repeat(200000) }, { kind: 'skill', text: 'x'.repeat(100000) }]), /256 KiB/);
  await assert.rejects(composer.select('file:' + outside), /过期/);
  currentCwd = outside; await assert.rejects(composer.select(list.items.find(item => item.kind === 'skill').id), /工作区/); currentCwd = cwd;
  vscode.workspace.isTrusted = false; await assert.rejects(composer.query('@'), /信任/); vscode.workspace.isTrusted = true;
  await assert.rejects(composer.query('@', 'x'.repeat(129)), /无效/);
  await assert.rejects(composer.query('@', '', { aborted: true }), error => error.code === -32800);
  const find = vscode.workspace.findFiles, controller = new AbortController();
  vscode.workspace.findFiles = async () => { controller.abort(); return [uri(file)]; };
  await assert.rejects(composer.query('@', '', controller.signal), error => error.code === -32800); assert(cancelled);
  vscode.workspace.findFiles = find;
  list = await composer.query('@'); const open = vscode.workspace.openTextDocument;
  vscode.workspace.openTextDocument = async () => { vscode.workspace.isTrusted = false; return doc; };
  await assert.rejects(composer.select(list.items[0].id), /信任/); vscode.workspace.isTrusted = true; vscode.workspace.openTextDocument = open;
  await assert.rejects(composer.select(list.items[0].id), /过期/, 'Losing trust while loading invalidates all previous candidates');
  list = await composer.query('@');
  text = '\0binary'; await assert.rejects(composer.select(list.items[0].id), /文本/);
  text = '界'.repeat(90000); await assert.rejects(composer.select(list.items[0].id), /256 KiB/); text = 'unsaved';
  fs.writeFileSync(path.join(outside, 'external.js'), 'private');
  fs.symlinkSync(outside, path.join(cwd, 'linked'), 'junction');
  vscode.workspace.findFiles = async () => [uri(path.join(cwd, 'linked', 'external.js'))];
  list = await composer.query('@'); await assert.rejects(composer.select(list.items[0].id), /外部/);
  assert(matches('src/panel/view.js', 'spv')); assert(!matches('view.js', 'missing'));
  assert(fileGlob('src/view').includes('/*')); assert(fileGlob('a[').includes('[[]'));
  assert(finds > 0); console.log('Workspace completion, unsaved snapshots, selection, skill invocation, draft restore, cancellation, trust and path boundaries passed');
  const nested = path.join(cwd, 'nested'); fs.mkdirSync(nested);
  const nestedFile = path.join(nested, 'child.js'); fs.writeFileSync(nestedFile, 'child');
  currentCwd = nested; vscode.workspace.findFiles = async () => [uri(file), uri(nestedFile)];
  list = await composer.query('@'); assert.equal(list.items.length, 1); assert.equal(list.items[0].label, 'child.js');
  assert.equal((await composer.query('#', '当前')).items.length, 0, 'The active file outside the conversation directory must not be offered');
  list = await composer.query('@'); assert.equal((await composer.select(list.items[0].id)).name, 'child.js');
  currentCwd = cwd;
  const skillFile = path.join(cwd, '.dsh/skills/fallback/SKILL.md'); fs.mkdirSync(path.dirname(skillFile), { recursive: true }); fs.writeFileSync(skillFile, '# Local skill\nInstructions');
  let remoteCalls = 0;
  const offline = new ComposerContext({ vscode, workdir: () => currentCwd, connected: () => false, invoke: async () => { remoteCalls++; } });
  vscode.workspace.findFiles = async () => [uri(skillFile), uri(path.join(cwd, '.dsh/skills/fallback/.trash/old/SKILL.md')), uri(path.join(outside, 'SKILL.md'))];
  list = await offline.query('/', 'fallback'); assert.equal(list.items.length, 1); assert.equal(remoteCalls, 0);
  vscode.workspace.openTextDocument = async value => ({ ...doc, uri: value, getText: () => fs.readFileSync(value.fsPath, 'utf8') });
  const local = await offline.select(list.items[0].id); assert.equal(local.kind, 'skill'); assert(local.text.includes('Instructions'));
  const unavailable = new ComposerContext({ vscode, workdir: () => currentCwd, invoke: () => { remoteCalls++; throw new Error('Missing provider'); } });
  await unavailable.query('/'); await unavailable.query('/'); assert.equal(remoteCalls, 1, 'Unavailable provider scans are briefly cached');
  vscode.workspace.textDocuments = [{ uri: uri(file) }]; vscode.workspace.findFiles = async () => [uri(nestedFile)];
  list = await offline.query('@'); assert.equal(list.items[0].label, 'space 文件.js'); assert.equal(list.items[0].description, '已打开文件');
  const large = path.join(cwd, 'large.txt'); fs.writeFileSync(large, 'x'.repeat(300000));
  vscode.workspace.findFiles = async () => [uri(large)]; list = await offline.query('@', 'large');
  let openedLarge = false; vscode.workspace.openTextDocument = async () => { openedLarge = true; return doc; };
  await assert.rejects(offline.select(list.items[0].id), /256 KiB/); assert.equal(openedLarge, false);

  // All explicit sources share add-time snapshots, including saved files.
  let sessionId = 'session-a';
  const listeners = {};
  vscode.window.onDidChangeActiveTextEditor = callback => { listeners.active = callback; return { dispose() {} }; };
  vscode.window.onDidChangeTextEditorSelection = callback => { listeners.selection = callback; return { dispose() {} }; };
  vscode.workspace.onDidCloseTextDocument = callback => { listeners.close = callback; return { dispose() {} }; };
  vscode.workspace.onDidGrantWorkspaceTrust = callback => { listeners.trust = callback; return { dispose() {} }; };
  vscode.workspace.textDocuments = [doc];
  vscode.workspace.openTextDocument = async () => doc;
  vscode.workspace.findFiles = async () => [uri(file)];
  vscode.window.activeTextEditor = { document: doc, selection: range };
  text = '全文件\r\n```\r\n正文尾部  \r\n'; doc.isDirty = false; doc.version++;
  const explicit = new ComposerContext({ vscode, workdir: () => currentCwd, sessionId: () => sessionId, invoke });
  list = await explicit.query('#', '', undefined, { origin: 'context', source: 'file', requestId: 101 });
  assert.deepEqual(list.items.map(item => item.label), ['当前文件']);
  await assert.rejects(explicit.select(list.items[0].id, undefined, { origin: 'context', source: 'selection', queryRequestId: 101 }), /来源/);
  await assert.rejects(explicit.select(list.items[0].id, undefined, { origin: 'context', source: 'file', queryRequestId: 100 }), /来源/);
  const whole = await explicit.select(list.items[0].id, undefined, { origin: 'context', source: 'file', queryRequestId: 101 });
  assert.equal(whole.text, text); assert.equal(whole.scope, 'file'); assert.equal(whole.sourcePath, file); assert.equal(whole.sourceUri, doc.uri.toString());
  assert.equal(whole.uri, undefined); assert.equal(whole.isDirty, false); assert.equal(whole.byteLength, Buffer.byteLength(text)); assert(!Number.isNaN(Date.parse(whole.snapshotAt)));
  const savedBody = whole.text, queued = snapshotMessage('保持输入', [whole]);
  text = 'changed after capture'; doc.version++;
  assert.equal(queued.attachments[0].text, savedBody);
  assert.equal(queued.attachments[0].sourcePath, file); assert.equal(queued.attachments[0].snapshotAt, whole.snapshotAt);
  const sent = buildPromptBlocks(queued.text, queued.attachments);
  assert.equal(sent.length, 2); assert(sent[0].text.includes(savedBody)); assert(sent[0].text.includes('加入时已保存')); assert(!sent.some(block => block.type === 'resource_link'));
  const restoredWhole = normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: '保持输入', attachments: [whole], recoveries: [{ text: 'retained', attachments: [whole] }] }, { cwd });
  assert.deepEqual(restoredWhole.attachments[0], queued.attachments[0]); assert.deepEqual(restoredWhole.recoveries[0].attachments[0], queued.attachments[0]);
  const queue = new MessageQueue(); const entry = queue.add(queued, { cwd, sessionId }, 1); queue.take(); queue.finish('failure');
  assert.deepEqual(queue.remove(entry.id).attachments[0], queued.attachments[0]);

  // A panel focus change retains the editor selection but rejects changed versions.
  doc.lineCount = 3; text = 'abc\r\nsecond\r\n'; doc.isDirty = true;
  const endingAtNextLine = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
  vscode.window.activeTextEditor = { document: doc, selection: endingAtNextLine };
  listeners.selection({ textEditor: vscode.window.activeTextEditor }); vscode.window.activeTextEditor = undefined;
  list = await explicit.query('#', '', undefined, { origin: 'context', source: 'selection', requestId: 102 });
  assert.equal(list.items.length, 1); assert(list.items[0].description.includes('1–1 行'));
  const snippet = await explicit.select(list.items[0].id);
  assert.equal(snippet.scope, 'selection'); assert.equal(snippet.endLine, 1); assert.equal(snippet.rangeEndLine, 2); assert.equal(snippet.endCharacter, 0); assert.equal(snippet.isDirty, true);
  const snippetRestore = normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: 'selection', attachments: [snippet] }, { cwd }).attachments[0];
  assert.equal(snippetRestore.startLine, 1); assert.equal(snippetRestore.endLine, 1); assert.equal(snippetRestore.rangeEndLine, 2); assert.equal(snippetRestore.documentVersion, doc.version);
  doc.version++; await assert.rejects(explicit.select(list.items[0].id), /变化/);
  listeners.close(doc); await assert.rejects(explicit.select(list.items[0].id), /过期/);
  assert.equal((await explicit.query('#', '', undefined, { origin: 'context', source: 'selection' })).items.length, 0);

  listeners.active({ document: doc, selection: range });
  listeners.active({ document: { ...doc, uri: uri(path.join(outside, 'external.js')) }, selection: range });
  assert.equal((await explicit.query('#', '', undefined, { origin: 'context', source: 'file' })).items.length, 0, 'An outside editor clears the previously valid current file');
  listeners.active({ document: doc, selection: range });
  listeners.active({ document: { ...doc, uri: { scheme: 'output' } }, selection: range });
  assert.equal((await explicit.query('#', '', undefined, { origin: 'context', source: 'selection' })).items.length, 0, 'An unsupported active editor clears the previously valid selection');

  vscode.window.activeTextEditor = { document: doc, selection: range };
  list = await explicit.query('/', '', undefined, { origin: 'context', source: 'skill' });
  assert(list.items.length); assert(list.items.every(item => item.kind !== 'command'));
  sessionId = 'session-b'; await assert.rejects(explicit.select(list.items[0].id), /会话/);
  list = await explicit.query('@', '', undefined, { origin: 'context', source: 'search' });
  sessionId = 'session-c'; await assert.rejects(explicit.select(list.items[0].id), /会话/);
  list = await explicit.query('@');
  listeners.trust(); await assert.rejects(explicit.select(list.items[0].id), /过期/, 'Trust grant invalidates candidates created before a revoke/grant transition');

  // A delayed search cannot replace candidates from a newer query.
  const resolves = []; let started; vscode.workspace.findFiles = () => new Promise(resolve => { resolves.push(resolve); started?.(); });
  const firstStarted = new Promise(resolve => { started = resolve; });
  const late = explicit.query('@', 'space'), lateRejected = assert.rejects(late, error => error.code === -32800);
  await firstStarted;
  const secondStarted = new Promise(resolve => { started = resolve; });
  const latest = explicit.query('@', 'space'); await secondStarted; resolves[1]([uri(file)]); const fresh = await latest;
  resolves[0]([uri(file)]); await lateRejected; assert.equal((await explicit.select(fresh.items[0].id)).sourcePath, file);
  vscode.workspace.findFiles = async () => [uri(file)];

  currentCwd = path.join(cwd, 'linked');
  await assert.rejects(explicit.query('@', '', undefined, { origin: 'context', source: 'search' }), /目录链接.*外部/);
  await assert.rejects(explicit.query('/', '', undefined, { origin: 'context', source: 'skill' }), /目录链接.*外部/);
  currentCwd = cwd;

  const swapped = path.join(cwd, 'swapped'); fs.symlinkSync(nested, swapped, 'junction'); fs.writeFileSync(path.join(outside, 'child.js'), 'outside');
  const swappedUri = uri(path.join(swapped, 'child.js'));
  vscode.workspace.findFiles = async () => [swappedUri];
  list = await explicit.query('@');
  vscode.workspace.openTextDocument = async () => { fs.unlinkSync(swapped); fs.symlinkSync(outside, swapped, 'junction'); return { ...doc, uri: swappedUri }; };
  await assert.rejects(explicit.select(list.items.find(item => item.label === 'swapped/child.js').id), /外部/, 'A junction retargeted while opening the document must be rejected after reading');
  fs.unlinkSync(swapped); vscode.workspace.findFiles = async () => [uri(file)]; vscode.workspace.openTextDocument = async () => doc;

  // Untitled, empty and multibyte bodies retain their exact bytes and limits.
  const untitled = { ...doc, uri: { scheme: 'untitled', path: 'Untitled-1', toString: () => 'untitled:Untitled-1' }, fileName: 'Untitled-1', isUntitled: true, getText: () => '' };
  vscode.window.activeTextEditor = { document: untitled, selection: { isEmpty: true } }; vscode.workspace.openTextDocument = async () => untitled;
  const empty = await explicit.fromEditor(vscode.window.activeTextEditor, 'file'); assert.equal(empty.text, ''); assert.equal(empty.isUntitled, true); assert.equal(empty.byteLength, 0);
  assert.equal(buildPromptBlocks('', [empty]).length, 2);
  const multibyte = { ...whole, text: '界'.repeat(87381) };
  assert.equal(snapshotMessage('limit', [multibyte]).attachments[0].byteLength, 262143);
  assert.throws(() => snapshotMessage('limit', [multibyte, { kind: 'content', name: 'extra', text: '界' }]), /256 KiB/);
  assert.equal(snapshotMessage('twenty', Array(20).fill(empty)).attachments.length, 20);
  assert.throws(() => snapshotMessage('twenty-one', Array(21).fill(empty)), /20 项/);
  assert.equal(normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: 'draft', attachments: Array(21).fill(empty) }, { cwd }), undefined);
  assert.equal(normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: 'draft', attachments: [multibyte, { kind: 'content', name: 'extra', text: '界' }] }, { cwd }), undefined);
  const recoveries = Array.from({ length: 5 }, (_, index) => ({ text: String(index), attachments: [{ ...whole, text: 'x'.repeat(110000) }] }));
  assert.equal(normalizeDraft({ version: 1, cwd, savedAt: Date.now(), text: 'draft', attachments: [], recoveries }, { cwd }), undefined);

  let resolveRead, startedRead;
  const readStarted = new Promise(resolve => { startedRead = resolve; });
  const delayedSkills = new ComposerContext({ vscode, workdir: () => currentCwd, sessionId: () => sessionId, invoke: async (id, input, context) => {
    if (id.endsWith('.list')) return invoke(id, input, context);
    startedRead(); return new Promise(resolve => { resolveRead = resolve; });
  } });
  list = await delayedSkills.query('/', '', undefined, { origin: 'context', source: 'skill' });
  const lateSkill = delayedSkills.select(list.items[0].id), rejectedSkill = assert.rejects(lateSkill, /会话/);
  await readStarted; sessionId = 'session-d'; resolveRead({ value: { content: 'stale instructions' } }); await rejectedSkill;
  delayedSkills.dispose();
  explicit.dispose();
  console.log('Explicit context sources, exact snapshots, metadata recovery, recent selection, session/source/request isolation and UTF-8 aggregate limits passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (fs.existsSync(path.join(cwd, 'linked'))) fs.unlinkSync(path.join(cwd, 'linked'));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
