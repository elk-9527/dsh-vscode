'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ReportStore, MAX_REPORT } = require('../src/bridge/report-store');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const op = (id, cwd, caseKey) => ({ id, cwd, caseKey, status: 'completed', fingerprint: 'snapshot', indexFingerprint: 'b'.repeat(64), headState: 'unborn', clientId: 'client', instanceId: 'kernel',
  input: { mode: 'worktree', instructions: 'PRIVATE_REQUIREMENT' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
const report = { verdict: 'Review finished', findings: [{ title: 'Finding', body: 'Complete body', file: 'sample.js', startLine: 1 }] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const denied = code => Object.assign(new Error('Fixture ticket access denied'), { code });
async function ticketFixture(root, name, count = 1) {
  const directory = path.join(root, name), store = new ReportStore({ directory });
  await store.ready();
  const peers = [];
  for (let i = 1; i <= count; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    const file = path.join(directory, `.writer.${process.pid}.${id}`);
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, id, ticket: i }));
    peers.push(file);
  }
  return { directory, store, peers };
}
async function ticketScanRegressions(root) {
  {
    const { directory, store, peers } = await ticketFixture(root, 'ticket-election', 2);
    const read = store.readFile.bind(store), reads = new Map();
    let firstPeer, refusedPeer, recovered, publishedAtRecovery, entered = false;
    const recovery = new Promise(resolve => { recovered = resolve; });
    store.readFile = async file => {
      if (!peers.includes(file)) return read(file);
      reads.set(file, (reads.get(file) || 0) + 1);
      firstPeer ||= file;
      if (file !== firstPeer && !refusedPeer) { refusedPeer = file; throw denied('EPERM'); }
      const value = await read(file);
      if (file === refusedPeer) {
        publishedAtRecovery = (await fs.readdir(directory)).some(name => name.startsWith('.writer.') && !peers.includes(path.join(directory, name)));
        recovered();
      }
      return value;
    };
    const pending = store.locked(() => { entered = true; return 'saved'; });
    await Promise.race([recovery, pending]);
    assert(refusedPeer && reads.get(firstPeer) >= 2, 'Election restarts the entire scan after a peer access failure');
    assert.equal(publishedAtRecovery, false, 'An unread peer cannot be treated as an absent election ticket');
    await pause(80);
    assert.equal(entered, false, 'A recovered active peer continues to block the critical section');
    for (const file of peers) await fs.unlink(file);
    assert.equal(await pending, 'saved');
    assert.equal(entered, true);
  }
  {
    const { store, peers } = await ticketFixture(root, 'ticket-waiting');
    const read = store.readFile.bind(store); let reads = 0, recovered, entered = false;
    const recovery = new Promise(resolve => { recovered = resolve; });
    store.readFile = async file => {
      if (file !== peers[0]) return read(file);
      reads += 1;
      if (reads === 2) throw denied('EBUSY');
      const value = await read(file);
      if (reads >= 3) recovered();
      return value;
    };
    const pending = store.locked(() => { entered = true; return 'saved'; });
    await Promise.race([recovery, pending]);
    assert(reads >= 3, 'Waiting scans retry a transient busy ticket');
    await pause(80);
    assert.equal(entered, false, 'A retry does not skip the active peer');
    await fs.unlink(peers[0]);
    assert.equal(await pending, 'saved');
  }
  {
    const { directory, store, peers } = await ticketFixture(root, 'ticket-persistent');
    const read = store.readFile.bind(store); let attempts = 0, entered = false;
    store.readFile = async file => {
      if (file !== peers[0]) return read(file);
      attempts += 1;
      // 选票消耗一部分时间，再验证等待阶段不能重新获得五秒预算。
      if (attempts === 1) { await pause(2000); throw denied('EPERM'); }
      if (attempts === 2) return read(file);
      throw denied('EPERM');
    };
    const started = Date.now();
    await assert.rejects(store.locked(() => { entered = true; }), error => error.code === 'EPERM');
    const elapsed = Date.now() - started;
    assert(attempts >= 3 && elapsed >= 4000 && elapsed < 6500, `Persistent rejection exhausts one shared election and waiting budget (${elapsed}ms)`);
    assert.equal(entered, false, 'Persistent ticket rejection never enters the critical section');
    assert.deepEqual(await fs.readdir(directory), [path.basename(peers[0])], 'Failed acquisition removes only its own markers');
  }
  {
    const { store, peers } = await ticketFixture(root, 'ticket-invalid');
    await fs.writeFile(peers[0], JSON.stringify({ pid: process.pid, id: 'wrong-owner', ticket: 1 }));
    const read = store.readFile.bind(store); let reads = 0, entered = false;
    store.readFile = file => {
      if (file === peers[0] && ++reads === 1) return Promise.reject(denied('EPERM'));
      return read(file);
    };
    await assert.rejects(store.locked(() => { entered = true; }), /锁无效/);
    assert.equal(reads, 2, 'A transient rejection cannot bypass recovered owner validation');
    assert.equal(entered, false);
  }
  {
    const { store, peers } = await ticketFixture(root, 'ticket-permission');
    const read = store.readFile.bind(store); let reads = 0, entered = false;
    store.readFile = file => {
      if (file === peers[0]) { reads += 1; return Promise.reject(denied('EACCES')); }
      return read(file);
    };
    await assert.rejects(store.locked(() => { entered = true; }), error => error.code === 'EACCES');
    assert.equal(reads, 1, 'Other permission errors remain immediate failures');
    assert.equal(entered, false);
  }
  console.log('Ticket scan retries, active peers, shared deadlines and rejection boundaries passed');
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-report-store-'));
  try {
    const directory = path.join(root, 'reports'), first = new ReportStore({ directory }), second = new ReportStore({ directory });
    const run = op('one', root);
    const [a, b] = await Promise.all([first.save(run, report), second.save(run, report)]);
    assert.equal(a.key, b.key); assert.equal((await first.list()).length, 1);
    const body = await fs.readFile(first.file(a.key), 'utf8'); assert(!body.includes('PRIVATE_REQUIREMENT'));
    await assert.rejects(first.save(run, { verdict: 'changed' }), /不同结果/);
    assert.equal((await first.read(a.key)).report.findings[0].body, 'Complete body');
    assert.equal((await first.read(a.key)).operation.indexFingerprint, 'b'.repeat(64));
    assert.equal((await first.read(a.key)).operation.headState, 'unborn');
    const third = new ReportStore({ directory }); assert.equal((await third.list())[0].key, a.key);
    const child = await first.save(op('two', root, a.key), report);
    await second.append(a.key, { kind: 'review', operationKey: child.key });
    assert.equal((await first.events(a.key)).length, 1);
    assert.equal(await first.remove(a.key), false, 'A case parent remains while later reviews reference it');
    await fs.writeFile(path.join(directory, 'f'.repeat(64) + '.json'), '{');
    await fs.writeFile(path.join(directory, '.interrupted.tmp'), 'incomplete');
    assert.equal((await third.list()).length, 2, 'Corrupt and interrupted writes do not block valid history');
    const edited = JSON.parse(body); edited.report.findings[0].body = 'tampered'; await fs.writeFile(first.file(a.key), JSON.stringify(edited));
    await assert.rejects(first.read(a.key), /摘要无效/); await fs.writeFile(first.file(a.key), body);
    await assert.rejects(first.save(op('large', root), { rawText: 'a'.repeat(MAX_REPORT) }), /超限/);
    const capped = new ReportStore({ directory: path.join(root, 'capped'), maxReports: 1 });
    const initial = await capped.save(op('initial', root), report);
    await capped.append(initial.key, { kind: 'test', executionId: 'test', status: 'passed' });
    await capped.pin(initial.key, 'open-document');
    const other = new ReportStore({ directory: capped.directory, maxReports: 1 });
    await assert.rejects(other.save(op('blocked', root), report), /空间不足/);
    await capped.unpin(initial.key, 'open-document');
    const replacement = await other.save(op('replacement', root), report);
    assert.equal((await capped.list()).length, 1); assert.equal((await capped.events(initial.key)).length, 0);
    assert.equal((await capped.list())[0].key, replacement.key);
    const originalLink = fs.link;
    fs.link = async (from, to) => { if (to.endsWith('.json')) throw Object.assign(new Error('Fixture full disk'), { code: 'ENOSPC' }); return originalLink(from, to); };
    try { await assert.rejects(other.save(op('failed-replacement', root), report), /full disk/); }
    finally { fs.link = originalLink; }
    assert.equal((await capped.read(replacement.key)).report.findings[0].body, 'Complete body', 'A failed commit cannot reclaim an older report');
    const storePath = require.resolve('../src/bridge/report-store');
    const program = `const {ReportStore}=require(process.argv[1]); const store=new ReportStore({directory:process.argv[2]}); store.save(JSON.parse(process.argv[3]),{findings:[]}).catch(e=>{console.error(e.message);process.exitCode=1})`;
    await Promise.all(Array.from({ length: 3 }, (_, i) => exec(process.execPath, ['-e', program, storePath, path.join(root, 'multi-process'), JSON.stringify(op(`process-${i}`, root))])));
    assert.equal((await new ReportStore({ directory: path.join(root, 'multi-process') }).list()).length, 3);
    const coordination = path.join(root, 'coordination'); await fs.mkdir(coordination);
    const dead = '00000000-0000-0000-0000-000000000000';
    await fs.writeFile(path.join(coordination, `.choosing.2147483647.${dead}`), '');
    await fs.writeFile(path.join(coordination, `.writer.2147483647.${dead}`), JSON.stringify({ pid: 2147483647, id: dead, ticket: 1 }));
    const mutual = `const fs=require('node:fs/promises'),path=require('node:path'),{ReportStore}=require(process.argv[1]); const directory=process.argv[2],store=new ReportStore({directory}); (async()=>{for(let i=0;i<8;i++)await store.locked(async()=>{const active=path.join(directory,'critical');await fs.writeFile(active,'owned',{flag:'wx'});try{const file=path.join(directory,'counter'),n=Number(await fs.readFile(file,'utf8').catch(()=>0));await new Promise(r=>setTimeout(r,5));await fs.writeFile(file,String(n+1))}finally{await fs.unlink(active)}})})().catch(e=>{console.error(e.message);process.exitCode=1})`;
    await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ['-e', mutual, storePath, coordination])));
    assert.equal(Number(await fs.readFile(path.join(coordination, 'counter'))), 32, 'Dead-claim recovery keeps all concurrent critical sections mutually exclusive');
    await ticketScanRegressions(root);
    await fs.writeFile(path.join(directory, '.write-lock'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    await first.save(op('recover-lock', root), report); assert.equal((await first.list()).length, 3);
    const series = path.join(root, 'series'), seriesStore = new ReportStore({ directory: series });
    const seriesRun = await seriesStore.save(op('series', root), report), { digest } = require('../src/bridge/report-store');
    const at = '2026-01-01T00:00:00.000Z';
    const values = Array.from({ length: 501 }, (_, i) => {
      const id = require('node:crypto').randomUUID(), payload = { kind: 'test', executionId: 'retained-execution', status: 'passed', stale: i === 500 };
      return { id, schemaVersion: 1, kind: 'evidence', caseKey: seriesRun.key, seq: i + 1, at, payload, payloadDigest: digest(payload) };
    });
    await Promise.all(values.map(value => fs.writeFile(seriesStore.file(seriesRun.key, value.id), JSON.stringify(value))));
    const history = await seriesStore.events(seriesRun.key);
    assert.equal(history.length, 501); assert.equal(history.at(-1).payload.stale, true, 'Latest state is retained past 500 evidence records and equal timestamps');
    const latest = await seriesStore.append(seriesRun.key, { kind: 'test', executionId: 'retained-execution', status: 'cancelled', at });
    assert.equal(latest.seq, 502); assert.equal((await seriesStore.events(seriesRun.key)).at(-1).payload.status, 'cancelled');
    const upgraded = new ReportStore({ directory: path.join(root, 'upgraded') });
    await upgraded.importLegacy(series);
    assert.equal((await upgraded.read(seriesRun.key)).report.findings[0].body, 'Complete body');
    assert.equal((await upgraded.events(seriesRun.key)).length, 502);
    await upgraded.remove(seriesRun.key); await upgraded.importLegacy(series);
    assert.equal((await upgraded.list()).length, 0, 'One-time legacy import cannot resurrect explicitly removed data');
    assert.equal((await seriesStore.events(seriesRun.key)).length, 502, 'Migration never mutates old evidence');
    const legacySmall = new ReportStore({ directory: path.join(root, 'legacy-small') }), resumeStore = new ReportStore({ directory: path.join(root, 'resume-import') });
    const legacyRun = await legacySmall.save(op('legacy-small', root), report);
    await legacySmall.append(legacyRun.key, { kind: 'fix', file: 'sample.js', before: 'bad', after: 'good' });
    await legacySmall.append(legacyRun.key, { kind: 'test', executionId: 'legacy-test', status: 'failed' });
    fs.link = async (from, to) => { if (path.dirname(to) === resumeStore.directory && /\.[a-f0-9-]{36}\.json$/.test(to)) throw Object.assign(new Error('Fixture import interruption'), { code: 'ENOSPC' }); return originalLink(from, to); };
    try { await assert.rejects(resumeStore.importLegacy(legacySmall.directory), /interruption/); }
    finally { fs.link = originalLink; }
    assert.equal((await resumeStore.read(legacyRun.key)).report.findings[0].body, 'Complete body'); assert.equal(await resumeStore.migrationPending(legacyRun.key), true);
    await resumeStore.importLegacy(legacySmall.directory);
    assert.equal((await resumeStore.events(legacyRun.key)).length, 2); assert.equal(await resumeStore.migrationPending(legacyRun.key), false);
    const linked = path.join(root, 'linked'); await fs.symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(new ReportStore({ directory: linked }).list(), /位置无效/);
    assert.equal(await first.remove(child.key), true); assert.equal(await first.remove(a.key), true);
    await Promise.all([first.dispose(), second.dispose(), capped.dispose()]);
    console.log('Complete immutable reports, offline reads, corruption, quota, pins, concurrent processes and interruption recovery passed');
  } finally { assert(path.dirname(root) === os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
