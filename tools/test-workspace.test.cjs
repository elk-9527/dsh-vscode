'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createFixture } = require('./test-workspace.cjs');

const sentinel = createFixture('cleanup-sentinel');
fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'keep');
const helper = require.resolve('./test-workspace.cjs');
for (const exitCode of [0, 7]) {
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const folder = require(process.argv[1]).createFixture('cleanup-child');
    fs.writeFileSync(path.join(folder, 'temporary.txt'), 'temporary');
    fs.symlinkSync(process.argv[2], path.join(folder, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    console.log(folder);
    process.exit(Number(process.argv[3]));
  `, helper, sentinel, String(exitCode)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, exitCode, child.stderr);
  const folder = child.stdout.trim();
  assert.equal(path.dirname(folder), path.resolve(__dirname, '../build/tests'));
  assert.equal(fs.existsSync(folder), false, 'Success and failure must both clean owned fixtures');
  assert.equal(fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf8'), 'keep', 'Cleanup must not follow a fixture link');
}
assert.throws(() => createFixture('../escape'), /label/);
console.log('PASS fixture cleanup on success and failure preserves linked external files');
