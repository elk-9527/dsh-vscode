'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveFileLink } = require('../src/panel/links');

(async () => {
  const parent = path.resolve(__dirname, '../../../build/test-runs');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'file-links-'));
  const workspace = path.join(folder, 'workspace'), outside = path.join(folder, 'outside');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true }); await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, 'src', '入口 (1).js'), 'hello');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try {
    const actual = await fs.realpath(path.join(workspace, 'src', '入口 (1).js'));
    assert.deepEqual(await resolveFileLink('src/入口%20(1).js#L12-L15', workspace), { file: actual, line: 11 });
    assert.equal((await resolveFileLink('./src/入口%20(1).js', workspace)).file, actual);
    for (const href of ['../outside/secret.txt', '%2e%2e/outside/secret.txt', '/etc/passwd', 'C:/secret.txt', 'file:///secret',
      'command:run', 'javascript:alert(1)', '//example.com/secret', '\\\\server\\share', 'src/%00', 'src/%ZZ', 'src/%5c..%5csecret',
      'https://example.com', 'missing.js', 'src', '?query', '#L10', 'src/入口%20(1).js?query']) assert.equal(await resolveFileLink(href, workspace), undefined, href);
    const link = path.join(workspace, 'external');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await resolveFileLink('external/secret.txt', workspace), undefined);
    await fs.unlink(link);
    const Module = require('node:module'), originalLoad = Module._load;
    const opened = [], shown = [], external = [];
    let cwd = workspace, revoke = false;
    const vscode = {
      Uri: { file: file => ({ fsPath: file }), parse: value => value },
      Range: class { constructor(line, column, endLine, endColumn) { Object.assign(this, { line, column, endLine, endColumn }); } },
      env: { async openExternal(uri) { external.push(uri); } },
      workspace: {
        isTrusted: true,
        getWorkspaceFolder(uri) { return !path.relative(workspace, uri.fsPath).startsWith('..') ? { uri: { fsPath: workspace } } : undefined; },
        async openTextDocument(uri) { opened.push(uri.fsPath); if (revoke) vscode.workspace.isTrusted = false; return { uri }; },
      },
      window: { async showTextDocument(document, options) { shown.push({ document, options }); } },
    };
    let PanelProvider;
    try { Module._load = function (request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); }; PanelProvider = require('../src/panel/view').DshPanelView; }
    finally { Module._load = originalLoad; }
    const panel = { workdir: () => cwd };
    await PanelProvider.prototype.openLink.call(panel, 'src/入口%20(1).js#L12');
    assert.equal(opened[0], actual); assert.equal(shown[0].options.selection.line, 11);
    await PanelProvider.prototype.openLink.call(panel, 'command:run'); assert.equal(opened.length, 1);
    vscode.workspace.isTrusted = false;
    await PanelProvider.prototype.openLink.call(panel, 'src/入口%20(1).js'); assert.equal(opened.length, 1);
    await PanelProvider.prototype.openLink.call(panel, 'https://example.com'); assert.deepEqual(external, ['https://example.com']);
    vscode.workspace.isTrusted = true; cwd = outside;
    await PanelProvider.prototype.openLink.call(panel, 'secret.txt'); assert.equal(opened.length, 1);
    cwd = workspace; revoke = true;
    await PanelProvider.prototype.openLink.call(panel, 'src/入口%20(1).js'); assert.equal(shown.length, 1, 'Revoked trust must prevent showing the document');
    console.log('PASS workspace file links: existing files, encoded names, line positions, protocol/escape/missing-file rejection and external links');
  } finally {
    const realParent = await fs.realpath(parent), realFolder = await fs.realpath(folder);
    assert.equal(path.dirname(realFolder), realParent);
    await fs.rm(realFolder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
