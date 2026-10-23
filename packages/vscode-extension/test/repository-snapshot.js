'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { repositorySnapshot, sameRepositorySnapshot, validateReviewInput } = require('../src/bridge/results');

(async () => {
  const parent = path.resolve(__dirname, '../../../build/test-snapshots');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  const empty = await repositorySnapshot(root);
  assert.equal(empty.headState, 'unborn'); assert.equal(empty.hasChanges, false);
  await fs.writeFile(path.join(root, 'new.txt'), 'first\n');
  const untracked = await repositorySnapshot(root);
  assert(untracked.hasChanges); assert.notEqual(untracked.fingerprint, empty.fingerprint);
  git('add', 'new.txt');
  const staged = await repositorySnapshot(root);
  assert(staged.hasChanges); assert.equal(staged.headState, 'unborn');
  assert.equal(staged.fingerprint, untracked.fingerprint, 'The original ordered content fingerprint remains unchanged by staging');
  assert.notEqual(staged.indexFingerprint, untracked.indexFingerprint, 'Staging has a separate snapshot identity');
  assert.equal(sameRepositorySnapshot(untracked, staged), false);
  assert.equal(sameRepositorySnapshot({ fingerprint: untracked.fingerprint }, staged), true, 'Older content-only records preserve their comparison semantics');
  await assert.rejects(validateReviewInput(root, { mode: 'base', ref: 'missing' }), /不存在/);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial fixture');
  const committed = await repositorySnapshot(root);
  assert.equal(committed.headState, 'committed'); assert(!committed.hasChanges);
  assert.notEqual(committed.fingerprint, staged.fingerprint);
  assert.match(await validateReviewInput(root, { mode: 'commit', ref: 'HEAD' }), /^[a-f0-9]{40,64}$/);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(repositorySnapshot(root, { signal: stop.signal }), error => error.name === 'AbortError');
  const outside = await fs.mkdtemp(path.join(parent, 'non-git-'));
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = parent;
  try { await assert.rejects(repositorySnapshot(outside), error => error.code === 'NOT_GIT_REPOSITORY'); }
  finally { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; }
  console.log('PASS unborn, untracked, staged, committed, missing ref, cancellation and non-Git snapshots');
})().catch(error => { console.error(error); process.exitCode = 1; });
