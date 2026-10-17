'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { readFileState } = require('../src/workflow/file-state');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-state-'));
  const originalOpen = fs.open;
  try {
    const cwd = path.join(root, 'repo'), inside = path.join(cwd, 'content'), outside = path.join(root, 'outside'), alias = path.join(cwd, 'alias');
    await fs.mkdir(inside, { recursive: true }); await fs.mkdir(outside);
    const file = path.join(alias, 'sample.txt'); await fs.writeFile(path.join(inside, 'sample.txt'), 'INSIDE'); await fs.writeFile(path.join(outside, 'sample.txt'), 'OUTSIDE');
    const type = process.platform === 'win32' ? 'junction' : 'dir'; await fs.symlink(inside, alias, type);
    let switched = false, opened;
    fs.open = async (target, ...args) => {
      const handle = await originalOpen(target, ...args); opened = target;
      if (!switched) {
        switched = true; await fs.unlink(alias); await fs.symlink(outside, alias, type);
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...args) => { const body = await read(...args); await fs.unlink(alias); await fs.symlink(inside, alias, type); return body; };
      }
      return handle;
    };
    const result = await readFileState({ workspace: { textDocuments: [] } }, file, cwd, () => {});
    assert.equal(opened, await fs.realpath(path.join(inside, 'sample.txt'))); assert.equal(result.text, 'INSIDE'); assert(!result.text.includes('OUTSIDE'));
    fs.open = originalOpen;
    await fs.unlink(alias); await fs.symlink(outside, alias, type);
    await assert.rejects(readFileState({ workspace: { textDocuments: [] } }, file, cwd, () => {}), /工作区外部/);
    console.log('Canonical file handles reject external links and keep alias switches from redirecting reads');
  } finally { fs.open = originalOpen; assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
