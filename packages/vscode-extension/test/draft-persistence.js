'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { DraftPersistence } = require('../src/panel/draft-persistence');
const { draftKey } = require('../src/panel/drafts');
const cwd = path.resolve(__dirname, '../../../build/test-draft-persistence/workspace');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const draft = (text, directory = cwd) => ({ version: 1, cwd: directory, savedAt: Date.now(), text, attachments: [] });

(async () => {
  const baselineValues = new Map(); let baselineWrites = 0, baseline = Promise.resolve(); const baselineStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const value = draft('revision ' + i);
    baseline = baseline.then(async () => { baselineWrites++; baselineValues.set(draftKey(value.cwd), structuredClone(value)); });
  }
  await baseline;
  const baselineElapsedMs = Number((performance.now() - baselineStart).toFixed(2));
  assert.equal(baselineValues.get(draftKey(cwd)).text, 'revision 999');
  const values = new Map(), calls = [], state = { get: key => values.get(key), update: async (key, value) => { calls.push({ key, value }); values.set(key, structuredClone(value)); } };
  const store = new DraftPersistence(state, { delayMs: 10000 });
  const start = performance.now(); const writes = [];
  for (let i = 0; i < 1000; i++) writes.push(store.set(draft('revision ' + i)));
  assert.equal(store.read(cwd).text, 'revision 999'); assert.equal(calls.length, 0); assert.equal(store.pending.size, 1);
  await store.flush(cwd); await Promise.all(writes);
  assert.equal(calls.length, 1); assert.equal(store.maxPending, 1); assert.equal(values.get(draftKey(cwd)).text, 'revision 999');
  const elapsedMs = Number((performance.now() - start).toFixed(2));
  const recovered = new DraftPersistence(state); assert.equal(recovered.read(cwd).text, 'revision 999');
  const elsewhere = path.join(cwd, 'second'); const a = store.set(draft('latest A')), b = store.set(draft('latest B', elsewhere));
  await store.flush(); await Promise.all([a, b]); assert.equal(calls.length, 3); assert.equal(store.maxPending, 2);
  assert.equal(values.get(draftKey(cwd)).text, 'latest A'); assert.equal(values.get(draftKey(elsewhere)).text, 'latest B');

  const gate = deferred(), ordered = [], storage = { get() {}, async update(key, value) { ordered.push(value.text); if (ordered.length === 1) await gate.promise; values.set(key, structuredClone(value)); } };
  const serialized = new DraftPersistence(storage, { delayMs: 10000 });
  const first = serialized.set(draft('first')); const flushing = serialized.flush(cwd); await tick();
  const second = serialized.set(draft('second')), third = serialized.set(draft('third')); const boundary = serialized.flush(cwd);
  assert.equal(serialized.read(cwd).text, 'third'); assert.equal(serialized.pending.size, 1);
  gate.resolve(); await Promise.all([first, second, third, flushing, boundary]);
  assert.deepEqual(ordered, ['first', 'third']); assert.equal(values.get(draftKey(cwd)).text, 'third');

  let failing = true;
  const failures = new DraftPersistence({ get() {}, async update(key, value) { if (failing) throw new Error('disk unavailable'); values.set(key, value); } }, { delayMs: 10000 });
  const saving = failures.set(draft('retained after failure')); await assert.rejects(failures.flush(), /disk unavailable/); await assert.rejects(saving);
  assert.equal(failures.read(cwd).text, 'retained after failure'); assert.equal(failures.pending.size, 1);
  failing = false; await failures.flush(); assert.equal(values.get(draftKey(cwd)).text, 'retained after failure');

  const boundaryValues = new Map(), boundaryWrites = [];
  const microtaskStore = new DraftPersistence({ get: key => boundaryValues.get(key), async update(key, value) { boundaryWrites.push(value.text); boundaryValues.set(key, structuredClone(value)); } }, { delayMs: 10000 });
  const boundaryFirst = microtaskStore.set(draft('boundary first'));
  const boundaryFirstFlush = microtaskStore.flush(cwd);
  const boundarySecondFlush = boundaryFirst.then(() => {
    void microtaskStore.set(draft('boundary second')).catch(() => {});
    return microtaskStore.flush(cwd);
  });
  await Promise.all([boundaryFirstFlush, boundarySecondFlush]);
  assert.deepEqual(boundaryWrites, ['boundary first', 'boundary second']);
  assert.equal(boundaryValues.get(draftKey(cwd)).text, 'boundary second', 'An explicit flush from the saved-promise microtask persists its revision before resolving');
  assert.equal(microtaskStore.pending.size, 0); assert.equal(microtaskStore.ready.size, 0); assert.equal(microtaskStore.timers.size, 0);

  const adjacentFirst = microtaskStore.set(draft('adjacent first'));
  const adjacentFlush = microtaskStore.flush(cwd);
  const adjacentOther = adjacentFirst.then(() => { void microtaskStore.set(draft('neighbor latest', elsewhere)).catch(() => {}); return microtaskStore.flush(elsewhere); });
  const adjacentCurrent = adjacentFirst.then(() => { void microtaskStore.set(draft('current latest')).catch(() => {}); return microtaskStore.flush(cwd); });
  await Promise.all([adjacentFlush, adjacentOther, adjacentCurrent]);
  assert.equal(boundaryValues.get(draftKey(cwd)).text, 'current latest'); assert.equal(boundaryValues.get(draftKey(elsewhere)).text, 'neighbor latest');
  assert.equal(microtaskStore.pending.size, 0); assert.equal(microtaskStore.ready.size, 0);

  let boundaryFail = false, boundaryAttempts = 0;
  const retryStore = new DraftPersistence({ get() {}, async update(key, value) {
    boundaryAttempts++; if (boundaryFail) throw new Error('boundary disk unavailable'); boundaryValues.set(key, structuredClone(value));
  } }, { delayMs: 10000 });
  const retryFirst = retryStore.set(draft('retry first')); const retryFirstFlush = retryStore.flush(cwd);
  const retrySecondFlush = retryFirst.then(() => {
    boundaryFail = true; void retryStore.set(draft('retry latest')).catch(() => {}); return retryStore.flush(cwd);
  });
  await retryFirstFlush; await assert.rejects(retrySecondFlush, /boundary disk unavailable/);
  assert.equal(boundaryAttempts, 2); await tick(); assert.equal(boundaryAttempts, 2, 'A failed boundary flush never retries indefinitely');
  await assert.rejects(retryStore.flush(cwd), /boundary disk unavailable/); assert.equal(boundaryAttempts, 3);
  assert.equal(retryStore.read(cwd).text, 'retry latest'); assert.equal(retryStore.pending.size, 1);
  boundaryFail = false; await retryStore.flush(cwd); assert.equal(boundaryAttempts, 4); assert.equal(boundaryValues.get(draftKey(cwd)).text, 'retry latest');

  for (const nextDirectory of [cwd, elsewhere]) {
    const rejectedWrites = [], restoredValues = new Map(); let recoveredDisk = false, retryWrite, retryFlush;
    const rejectedStore = new DraftPersistence({ get: key => restoredValues.get(key), async update(key, value) {
      rejectedWrites.push(value.text); if (!recoveredDisk) throw new Error('initial disk failure'); restoredValues.set(key, structuredClone(value));
    } }, { delayMs: 10000 });
    const rejected = rejectedStore.set(draft('failed revision'));
    const rejectedFlush = rejectedStore.flush(cwd);
    const resumed = rejected.catch(() => {
      recoveredDisk = true;
      retryWrite = rejectedStore.set(draft('new revision after rejection', nextDirectory));
      retryFlush = rejectedStore.flush(nextDirectory);
      return retryFlush;
    });
    await assert.rejects(rejectedFlush, /initial disk failure/);
    await resumed; await retryWrite;
    assert.equal(restoredValues.get(draftKey(nextDirectory)).text, 'new revision after rejection');
    assert.equal(rejectedStore.ready.size, 0); assert.equal(rejectedStore.timers.size, 0);
    await rejectedStore.flush();
    assert.equal(rejectedStore.pending.size, 0);
  }
  let permanentAttempts = 0;
  const permanent = new DraftPersistence({ get() {}, async update() { permanentAttempts++; throw new Error('still unavailable'); } }, { delayMs: 10000 });
  const permanentWrite = permanent.set(draft('keep without spinning'));
  const failedFlush = permanent.flush(cwd), explicitlyQueuedRetry = permanent.flush(cwd);
  await Promise.all([assert.rejects(permanentWrite), assert.rejects(failedFlush), assert.rejects(explicitlyQueuedRetry)]);
  await tick(); assert.equal(permanentAttempts, 2, 'Each explicit flush retries once; failures never start an automatic retry loop');
  console.log(JSON.stringify({ fixture: '1000 draft revisions in one directory; in-memory storage', baselineWrites, baselineElapsedMs, actualWrites: 1, maxPending: 1, latestRecovered: 'revision 999', elapsedMs }));
  console.log('Draft persistence: immediate memory, coalescing, microtask boundary flushes, directory isolation, serialized writes, failure retention and explicit retry passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
