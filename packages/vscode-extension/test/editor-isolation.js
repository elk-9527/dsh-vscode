'use strict';
/** 拒绝测试触及日常账号目录，包括路径别名与便携模式覆盖。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isolatedEditorOptions, ownsEditorProcess, belongsToEditor } = require('../tools/editor-isolation.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-account-isolation-'));
const options = { userData: path.join(root, 'user'), extensions: path.join(root, 'extensions'), sharedData: path.join(root, 'shared') };
const alias = path.join(root, 'alias');
try {
  const portable = isolatedEditorOptions({ ...options, env: { APPDATA: process.env.APPDATA, VSCODE_PORTABLE: path.join(os.homedir(), '.vscode'), ELECTRON_RUN_AS_NODE: '1', DSH_PANEL_AUTOFOCUS: '1' } });
  assert(!('VSCODE_PORTABLE' in portable.env)); assert(!('ELECTRON_RUN_AS_NODE' in portable.env)); assert.equal(portable.env.DSH_PANEL_AUTOFOCUS, '1');
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: path.join(os.homedir(), '.vscode-shared') }), /日常数据/);
  assert.throws(() => isolatedEditorOptions({ ...options, userData: os.homedir() }), /日常数据/);
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: path.join(options.userData, 'shared') }), /独立/);
  assert(ownsEditorProcess('Code.exe --user-data-dir="' + options.userData + '" --verbose', options.userData));
  assert(ownsEditorProcess('Code.exe --user-data-dir=' + options.userData, options.userData));
  assert(!ownsEditorProcess('Code.exe --user-data-dir="' + options.userData + '-another"', options.userData));
  assert(!ownsEditorProcess('Code.exe --user-data-dir="' + path.join(os.homedir(), '.vscode') + '"', options.userData));
  const processes = [{ pid: 1, ppid: 0, name: 'Code.exe', cmdline: 'Code.exe --user-data-dir="' + options.userData + '"' },
    { pid: 2, ppid: 1, name: 'node.exe' }, { pid: 3, ppid: 2, name: 'cmd.exe' },
    { pid: 4, ppid: 0, name: 'Code.exe', cmdline: 'Code.exe --user-data-dir="' + options.userData + '-another"' }, { pid: 5, ppid: 4, name: 'cmd.exe' }];
  assert(belongsToEditor(processes[2], processes, options.userData)); assert(!belongsToEditor(processes[4], processes, options.userData));
  const fixtureAppData = path.join(root, 'appdata'), fixtureCode = path.join(fixtureAppData, 'Code'); fs.mkdirSync(fixtureCode, { recursive: true });
  fs.symlinkSync(fixtureCode, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: alias, env: { APPDATA: fixtureAppData } }), /日常数据/);
  fs.unlinkSync(alias);
  console.log('Editor isolation rejects daily storage, overlapping paths and aliases; portable overrides removed');
} finally {
  try { fs.unlinkSync(alias); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('dsh-account-isolation-'));
  fs.rmSync(root, { recursive: true, force: true });
}
