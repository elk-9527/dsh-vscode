'use strict';
const assert = require('node:assert/strict');
const { startReviewSubagent } = require('./review-runtime.cjs');
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
  console.log('PASS 审查子 Agent 的旧版启动、新版 activation、调用方接收及失败回收');
})().catch(error => { console.error(error); process.exitCode = 1; });
