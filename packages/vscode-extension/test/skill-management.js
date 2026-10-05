'use strict';
const assert = require('node:assert/strict'), Module = require('node:module');
let confirmation = '取消', trustAfterPreview = false, selected = '新建技能'; const commands = [], documents = new Map();
const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true, getWorkspaceFolder: () => ({}), openTextDocument: async options => ({ uri: { toString: () => 'untitled:skill' }, getText: () => options.content }) }, commands: { executeCommand: async (...args) => { commands.push(args); if (trustAfterPreview) vscode.workspace.isTrusted = false; } }, window: { showQuickPick: async items => items.find(item => item.label === selected) || items[0], showInputBox: async () => 'example', showInformationMessage: async () => confirmation, showTextDocument: async document => { vscode.window.activeTextEditor = { document }; } } };
const original = Module._load; Module._load = function(id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); }; const { BridgeViews } = require('../src/bridge/views'); Module._load = original;
const view = Object.create(BridgeViews.prototype), calls = [];
Object.assign(view, { skillDrafts: new Map(), chooseWorkspace: async () => 'workspace', document: (id, content) => { documents.set(id, content); return id; }, refresh: async () => {}, invoke: async (id, input, context) => {
  calls.push({ id, input, context });
  if (id.endsWith('preview')) return { value: { planId: 'plan', before: 'Before', after: input.content || 'After', file: 'workspace/.dsh/skills/example/SKILL.md', scope: 'project-dsh' } };
  if (id.endsWith('list')) return { value: { groups: [{ title: 'Project', skills: [{ id: 'writable', name: 'Example', editable: true, modelInvocable: true }, { id: 'readonly', name: 'System', editable: false }] }] } };
  if (id.endsWith('read')) return { value: { content: 'Original' } }; return { value: { ok: true } };
} });
(async () => {
  await view.manageSkills(); assert.equal(view.skillDrafts.size, 1); assert.equal(calls.length, 0, 'Creating a draft must not change the backend');
  await view.applySkillDraft(); assert.equal(view.skillDrafts.size, 1); assert(!calls.some(call => call.id.endsWith('commit'))); assert(commands.some(call => call[0] === 'vscode.diff'));
  confirmation = '确认应用'; await view.applySkillDraft(); assert.equal(view.skillDrafts.size, 0); assert.equal(calls.find(call => call.id.endsWith('commit')).context.approved, true);
  selected = '编辑技能'; await view.manageSkills(); assert.equal(view.skillDrafts.size, 1); assert(calls.some(call => call.id.endsWith('read') && call.input.skillId === 'writable'));
  trustAfterPreview = true; const before = calls.filter(call => call.id.endsWith('commit')).length; await assert.rejects(view.applySkillDraft(), error => error.code === -32044); assert.equal(calls.filter(call => call.id.endsWith('commit')).length, before); assert.equal(view.skillDrafts.size, 1);
  await assert.rejects(view.manageSkills(), error => error.code === -32044); vscode.workspace.isTrusted = true; trustAfterPreview = false;
  selected = '启用或禁用技能'; confirmation = '取消'; await view.manageSkills(); assert.equal(calls.at(-1).input.enabled, false);
  console.log('Skill drafts remain editable, cancel preserves content, diff precedes approval, writable selection and trust rechecks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
