'use strict';
const assert = require('node:assert/strict');
const { runtimeSupport } = require('../src/runtime-support');
for (const platform of ['win32', 'linux', 'darwin']) assert(runtimeSupport({ platform, workspaceFolders: [{ uri: { scheme: 'file' } }] }).supported);
for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'attached-container']) {
  assert.equal(runtimeSupport({ remoteName }).kind, 'remote'); assert(!runtimeSupport({ remoteName }).supported);
}
assert.equal(runtimeSupport({ workspaceFolders: [{ uri: { scheme: 'vscode-vfs' } }] }).kind, 'virtual');
assert(!runtimeSupport({ uiKind: 2 }).supported); assert(!runtimeSupport({ platform: 'freebsd' }).supported);
assert(runtimeSupport().supported);
console.log('PASS local desktop, remote host, virtual workspace and unsupported platform boundaries');
