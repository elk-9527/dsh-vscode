'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareReviewScope, relatedDocuments, identity } = require('../src/bridge/review-scope');
(async () => {
  const root = path.resolve(__dirname, '../../../build/scope-fixture');
  let choice, saved = 0, prompted;
  const document = { uri: { scheme: 'file', fsPath: path.join(root, 'one.js') }, isDirty: true,
    async save() { saved++; this.isDirty = false; return true; } };
  const other = { ...document, uri: { scheme: 'file', fsPath: path.resolve(root, '../another-project/two.js') }, async save() { throw new Error('unrelated document was saved'); } };
  const vscode = { workspace: { textDocuments: [document, other] }, window: {
    async showWarningMessage(message, options) { prompted = options.detail; return choice; },
  } };
  assert.deepEqual(relatedDocuments(vscode, root), [document]);
  choice = '仅审查磁盘内容'; assert.match(await prepareReviewScope(vscode, root), /未包含/); assert.equal(saved, 0);
  assert.equal(prompted, 'one.js');
  choice = '取消'; await assert.rejects(prepareReviewScope(vscode, root), error => error.code === -32800);
  choice = '保存这些文件后审查'; assert.match(await prepareReviewScope(vscode, root), /已保存/); assert.equal(saved, 1);
  document.isDirty = true; document.save = async () => false;
  await assert.rejects(prepareReviewScope(vscode, root), /未能保存/);
  document.save = async () => { document.isDirty = false; vscode.workspace.textDocuments.push({ ...document, isDirty: true }); return true; };
  await assert.rejects(prepareReviewScope(vscode, root), /新的未保存编辑/);
  const fs = require('node:fs');
  const parent = path.resolve(__dirname, '../../../build/test-review-aliases'); fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, 'alias-'));
  try {
    const actual = path.join(fixture, 'repo'), alias = path.join(fixture, 'repo-link');
    fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, 'sample.js'), 'one\n');
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = { isDirty: true, uri: { scheme: 'file', fsPath: path.join(alias, 'sample.js') } };
    vscode.workspace.textDocuments = [linked];
    assert.deepEqual(relatedDocuments(vscode, actual), [linked]);
    assert.equal(identity(linked.uri.fsPath), identity(path.join(actual, 'sample.js')), 'Dirty editor aliases and diagnostic paths share canonical identity');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent); assert(!fs.lstatSync(fixture).isSymbolicLink());
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  console.log('PASS related editor scope, explicit disk/save/cancel, save failure and concurrent edits');
})().catch(error => { console.error(error); process.exitCode = 1; });
