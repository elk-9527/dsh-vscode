'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startReviewSubagent } = require('./review-runtime.cjs');
const { prepareReviewContext, hasReviewMaterial, isInspectionTool } = require('./review-context.cjs');
async function contextTests() {
  const build = path.resolve(__dirname, '../../build'); await fs.mkdir(build, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(build, 'review-context-test-'));
  try {
  const git = (root, ...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  for (const format of ['sha1', 'sha256']) {
    const root = path.join(fixture, format); await fs.mkdir(root); git(root, 'init', '--object-format=' + format);
    const target = { mode: 'worktree' };
    await fs.writeFile(path.join(root, 'sample.js'), 'export const value = "初始";\n');
    let prepared = await prepareReviewContext(root, target);
    assert.equal(prepared.complete, true); assert.equal(prepared.snapshot.files[0].content, 'export const value = "初始";\n');
    assert.equal(prepared.snapshot.stagedDiff, '');
    git(root, 'add', 'sample.js');
    await fs.writeFile(path.join(root, 'sample.js'), 'export const value = "磁盘";\n');
    prepared = await prepareReviewContext(root, target);
    assert.equal(prepared.complete, true); assert.match(prepared.snapshot.stagedDiff, /初始/);
    assert.match(prepared.snapshot.unstagedDiff, /磁盘/); assert.match(prepared.snapshot.files[0].content, /磁盘/);
    assert.throws(() => git(root, 'rev-parse', '--verify', 'HEAD'), /Command failed/);
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
    await fs.rename(path.join(root, 'sample.js'), path.join(root, 'renamed.js'));
    prepared = await prepareReviewContext(root, target);
    assert.equal(prepared.complete, true); assert.deepEqual(prepared.snapshot.files.map(file => file.path), ['renamed.js', 'sample.js']);
    assert.equal(prepared.snapshot.files[1].deleted, true);
    assert.equal((await prepareReviewContext(root, target, undefined, { maxFiles: 1 })).reason, 'file-budget');
    assert.equal((await prepareReviewContext(root, target, undefined, { limitBytes: 256 })).complete, false);
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
    prepared = await prepareReviewContext(root, target); assert.equal(prepared.reason, 'binary-file'); assert.equal(prepared.snapshot, undefined);
    await fs.unlink(path.join(root, 'binary'));
    await fs.writeFile(path.join(root, 'large'), 'x'.repeat(20000));
    assert.equal((await prepareReviewContext(root, target)).reason, 'context-budget');
    await fs.unlink(path.join(root, 'large'));
    assert.equal((await prepareReviewContext(root, { mode: 'commit', ref: 'HEAD' })).reason, 'native-target');
    const cancelled = new AbortController(); cancelled.abort(new Error('fixture cancelled'));
    await assert.rejects(prepareReviewContext(root, target, cancelled.signal), /fixture cancelled/);
    const subdirectory = path.join(root, 'nested'); await fs.mkdir(subdirectory);
    assert.equal((await prepareReviewContext(subdirectory, target)).reason, 'path-scope');
    const external = path.join(fixture, 'external-' + format); await fs.mkdir(external); await fs.writeFile(path.join(external, 'secret'), 'outside');
    await fs.symlink(external, path.join(root, 'outside'), 'junction');
    assert.equal((await prepareReviewContext(root, target)).complete, false);
    await fs.unlink(path.join(root, 'outside'));
  }
  const plain = path.join(fixture, 'plain'); await fs.mkdir(plain);
  // A directory inside the source checkout must never include the parent repository.
  assert.equal((await prepareReviewContext(plain, { mode: 'worktree' })).reason, 'path-scope');
  assert.equal(hasReviewMaterial({ mode: 'worktree' }, { complete: true }, 0), true);
  assert.equal(hasReviewMaterial({ mode: 'worktree' }, { complete: false }, 0), false);
  assert.equal(hasReviewMaterial({ mode: 'commit' }, undefined, 1), true);
  assert.equal(hasReviewMaterial({ mode: 'custom' }, undefined, 0), true);
  assert.equal(isInspectionTool('pwsh'), true); assert.equal(isInspectionTool('idle'), false);
  console.log('PASS 有界 Git 审查上下文：两种对象格式、首次提交前、暂存与磁盘差异、删除、预算、二进制、取消及路径边界');
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}
(async () => {
  const parent = { id: 'parent' }, child = { id: 'child' }, signal = new AbortController().signal;
  const result = Promise.resolve({ stopReason: 'completed', output: [] });
  let disposed = 0;
  const dispose = async () => { disposed++; };
  const request = { parent, label: 'review', persona: 'rubric', prompt: [{ type: 'text', text: 'review' }], signal, agentOptions: { model: 'review-model' } };
  const oldRun = { localAgent: child, result, dispose };
  assert.equal(await startReviewSubagent({ subagents: { async start(provider, input) { assert.equal(provider, 'spawn'); assert.equal(input, request); return oldRun; } } }, request), oldRun);
  const context = { subagents: { async startActivation(spec) {
    assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller'); assert.equal(spec.signal, signal); assert.equal(spec.label, 'review');
    assert.equal(spec.request.parent, parent); assert.deepEqual(spec.request.prompt, request.prompt); assert.deepEqual(spec.request.agentOptions, request.agentOptions);
    assert(!Object.hasOwn(spec.request, 'persona')); assert(!Object.hasOwn(spec.request, 'signal')); assert(!Object.hasOwn(spec.request, 'label'));
    return { childId: 'child', result, dispose };
  } }, agents: { get(id) { assert.equal(id, 'child'); return child; } } };
  const run = await startReviewSubagent(context, request);
  assert.equal(run.localAgent, child); assert.equal(run.result, result); await run.dispose(); assert.equal(disposed, 1);
  await assert.rejects(startReviewSubagent({ ...context, agents: { get() {} } }, request), /Agent 不可用/); assert.equal(disposed, 2);
  await assert.rejects(startReviewSubagent({ subagents: {} }, request), /启动接口/);
  await contextTests();
  console.log('PASS 审查子 Agent 的旧版启动、新版 activation、调用方接收及失败回收');
})().catch(error => { console.error(error); process.exitCode = 1; });
