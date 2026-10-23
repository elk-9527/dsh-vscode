'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRunResources } = require('./run-resources.cjs');
const { createFixture } = require('./test-workspace.cjs');

async function main() {
  const outside = createFixture('resource-sentinel');
  fs.writeFileSync(path.join(outside, 'keep'), 'unchanged');
  for (const failure of [false, true]) {
    const run = createRunResources({ label: 'lifecycle' });
    const original = process.env.DSH_RESOURCE_TEST;
    run.override({ DSH_RESOURCE_TEST: 'temporary' });
    fs.symlinkSync(outside, path.join(run.work, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(outside, 'missing'), path.join(run.work, 'stale'), process.platform === 'win32' ? 'junction' : 'dir');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
    run.defer('child', async () => { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; });
    try { await run.guard(() => { if (failure) throw new Error('installation failed'); }); }
    catch (error) { assert.equal(error.message, 'installation failed'); }
    assert.equal((await run.close()).status, 'passed');
    assert(!fs.existsSync(run.work)); assert.equal(process.env.DSH_RESOURCE_TEST, original);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unchanged');
    assert(child.exitCode !== null || child.signalCode !== null);
  }
  const a = createRunResources({ label: 'concurrent' }), b = createRunResources({ label: 'concurrent' });
  assert.notEqual(a.work, b.work); await a.close(); assert(fs.existsSync(b.work)); await b.close();
  for (const mode of ['timeout', 'cancel', 'space', 'output']) {
    const run = createRunResources({ label: mode, limits: mode === 'timeout' ? { timeMs: 30 } : mode === 'space' ? { bytes: 50 } : mode === 'output' ? { outputBytes: 4 } : {} });
    if (mode === 'cancel') run.cancel('test cancellation');
    if (mode === 'space') fs.writeFileSync(path.join(run.work, 'large'), Buffer.alloc(100));
    if (mode === 'output') run.appendLog(path.join(run.work, 'log'), 'too much output');
    let timer;
    await assert.rejects(run.guard(() => new Promise(resolve => { timer = setTimeout(resolve, 200); })), /limit|cancellation/);
    clearTimeout(timer);
    const result = await run.close(); assert(result.abort); assert(!fs.existsSync(run.work));
  }
  const kept = createRunResources({ label: 'kept', keep: true });
  const result = await kept.close(); assert(result.retained && result.bytes > 0);
  // Explicit retention is caller-owned evidence; the test removes only this recorded workspace.
  fs.rmSync(kept.work, { recursive: true });
  const replaced = createRunResources({ label: 'replaced' });
  const original = replaced.work + '-original'; fs.renameSync(replaced.work, original);
  fs.symlinkSync(outside, replaced.work, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await replaced.close()).status, 'failed');
  fs.unlinkSync(replaced.work); fs.rmSync(original, { recursive: true });
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unchanged');
  console.log('PASS owned validation resources: failure, cancellation, limits, concurrency, links and retention');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
