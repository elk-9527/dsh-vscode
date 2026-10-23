'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter, once, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { runDshAsync } = require('../src/door/locate');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

function loadProcessRunner({ spawn: start, platform = process.platform, kill = process.kill.bind(process), schedule = setTimeout }) {
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/door/process'), 'utf8'), {
    module: loaded, Buffer, process: { platform, kill }, setTimeout: schedule, clearTimeout,
    require: name => { assert.equal(name, 'node:child_process'); return { spawn: start }; },
  });
  return loaded.exports;
}

async function exitedLauncherBounds() {
  for (const platform of ['win32', 'linux']) for (const mode of ['timeout', 'cancel', 'output', 'close-race']) {
    const child = new EventEmitter(), signals = [], lines = [], abort = new AbortController();
    Object.assign(child, { pid: 987654, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { throw new Error('An exited launcher must not be signalled by PID'); } });
    let launches = 0;
    const runner = loadProcessRunner({ platform, spawn() { assert.equal(++launches, 1); return child; },
      kill: (pid, signal) => signals.push({ pid, signal }), schedule: (callback, delay) => setTimeout(callback, delay === 500 ? 1 : delay) });
    const running = runner.runCommand({ file: 'fixture-launcher', timeoutMs: mode === 'timeout' ? 20 : 0,
      signal: abort.signal, maxOutputBytes: mode === 'output' ? 3 : 1024, onOutput: item => lines.push(item.text) });
    child.exitCode = 0; child.emit('exit', 0, null);
    if (mode === 'cancel') abort.abort();
    if (mode === 'output') child.stdout.write('1234');
    if (mode === 'close-race') { child.stdout.write('tail'); abort.abort(); child.emit('close', 0, null); }
    await within(assert.rejects(running, error => error.code === ({ timeout: 'ETIMEDOUT', cancel: 'ECANCELLED', output: 'EMAXBUFFER', 'close-race': 'ECANCELLED' })[mode]),
      500, `${platform}/${mode}: inherited pipes prevented settlement`);
    assert(child.stdout.destroyed && child.stderr.destroyed, 'Stopped commands release inherited pipes');
    for (const stream of [child.stdout, child.stderr]) {
      assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('error'), 1);
      stream.emit('error', new Error('A pipe error was queued before cleanup'));
      assert.equal(stream.listenerCount('error'), 0, 'A queued error is absorbed once without retaining command listeners');
    }
    assert.equal(child.listenerCount('close'), 0); assert.equal(child.listenerCount('error'), 1);
    child.emit('error', new Error('A process error was queued before cleanup'));
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    assert.equal(launches, 1, 'An exited Windows PID must not be passed to taskkill');
    assert.deepEqual(signals, platform === 'win32' ? [] : [{ pid: -child.pid, signal: 'SIGTERM' }, { pid: -child.pid, signal: 'SIGKILL' }]);
    assert.deepEqual(lines, mode === 'close-race' ? ['tail'] : [], 'A close/stop race flushes pending output once');
    child.emit('close', 0, null);
  }
  const child = { pid: 987654, exitCode: null, signalCode: null, kill() { throw new Error('kill failed'); } };
  for (const platform of ['win32', 'linux']) {
    const runner = loadProcessRunner({ platform, spawn() { throw new Error('killer spawn failed'); },
      kill() { throw new Error('group kill failed'); }, schedule: callback => setTimeout(callback, 1) });
    await runner.stopOwnedProcess(child);
  }
}

function windowsProcessIdentity(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const text = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  return text ? JSON.parse(text) : undefined;
}

async function realExitedLaunchers(script, unrelated) {
  if (process.platform !== 'win32') return;
  for (const mode of ['timeout', 'cancel']) {
    let launcher, orphanPid, identity, launches = 0;
    const abort = new AbortController();
    const runner = loadProcessRunner({ spawn(...args) { launches++; const child = spawn(...args); launcher ||= child; return child; } });
    let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    const running = runner.runCommand({ file: process.execPath, args: [script, 'orphan'], signal: abort.signal,
      timeoutMs: mode === 'timeout' ? 2000 : 10000, onOutput: ({ text }) => {
        if (text.startsWith('orphan=')) { orphanPid = Number(text.slice(7)); ready(); }
      } });
    const outcome = running.then(() => ({ error: undefined }), error => ({ error }));
    const exited = once(launcher, 'exit');
    try {
      await within(readyPromise, 5000, 'Descendant fixture did not become ready');
      identity = windowsProcessIdentity(orphanPid);
      assert(identity && identity.path.toLowerCase() === process.execPath.toLowerCase()
        && identity.commandLine.includes(script) && identity.commandLine.includes('orphan-child'));
      assert.deepEqual(await exited, [0, null], 'Launcher exits before the inherited-pipe deadline');
      await wait(20);
      assert(!launcher.stdout.destroyed && !launcher.stderr.destroyed, 'The detached descendant retains the inherited pipes');
      const stoppedAt = Date.now();
      if (mode === 'cancel') abort.abort();
      const result = await within(outcome, 4000, 'Exited launcher exceeded its stop bound');
      assert.equal(result.error?.code, mode === 'timeout' ? 'ETIMEDOUT' : 'ECANCELLED');
      if (mode === 'cancel') assert(Date.now() - stoppedAt < 1000, 'Cancellation does not wait for descendant exit');
      assert(launcher.stdout.destroyed && launcher.stderr.destroyed);
      await runner.stopOwnedProcess(launcher);
      assert.equal(launches, 1, 'No taskkill is issued for the exited launcher');
      assert(exists(orphanPid), 'An exited Windows root cannot safely reclaim its detached descendant');
      assert(exists(unrelated.pid), 'An unrelated process survives inherited-pipe cleanup');
    } finally {
      if (orphanPid) {
        identity ||= windowsProcessIdentity(orphanPid);
        const current = windowsProcessIdentity(orphanPid);
        if (current) {
          assert(identity && current.created === identity.created && current.path === identity.path && current.commandLine === identity.commandLine
            && current.path.toLowerCase() === process.execPath.toLowerCase() && current.commandLine.includes(script)
            && current.commandLine.includes('orphan-child'), 'Only the recorded descendant identity may be cleaned up');
          process.kill(orphanPid);
          for (let attempt = 0; attempt < 20 && exists(orphanPid); attempt++) await wait(50);
          assert.equal(exists(orphanPid), false, 'The recorded fixture descendant is cleaned up');
        }
      }
      abort.abort(); await outcome;
    }
  }
  console.log('Windows exited-launcher fixtures: timeout and cancellation release inherited pipes; detached descendants require identity-checked fixture cleanup');
}

(async () => {
  await exitedLauncherBounds();
  const fixtures = path.resolve(__dirname, '../../../build/test-async-command'); fs.mkdirSync(fixtures, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtures, 'command space '));
  const script = path.join(root, 'probe command.cjs');
  fs.writeFileSync(script, `
    const mode = process.argv[2];
    if (mode === 'slow') setTimeout(() => process.stdout.write('done\\n'), 200);
    else if (mode === 'fail') { process.stderr.write('fixture failed\\n'); process.exitCode = 7; }
    else if (mode === 'secret') { process.stdout.write('http://localhost/?token='); setTimeout(() => process.stdout.write('test-secret\\n'), 10); }
    else if (mode === 'secret-fail') {
      process.stdout.write('http://localhost/?token=' + 'fixture-secret-marker-'.repeat(600) + '\\n');
      process.stderr.write('Authorization: Bearer ' + 'fixture-secret-marker-'.repeat(600) + '\\n');
      process.exitCode = 7;
    }
    else if (mode === 'orphan') {
      require('node:child_process').spawn(process.execPath, [__filename, 'orphan-child'], { detached: true, windowsHide: true, stdio: ['ignore', process.stdout, process.stderr] });
      setTimeout(() => process.exit(0), 100);
    }
    else if (mode === 'orphan-child') { process.stdout.write('orphan=' + process.pid + '\\n'); setTimeout(() => process.exit(0), 10000); }
    else if (mode === 'tree') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write('child=' + child.pid + '\\n'); setInterval(() => {}, 1000);
    } else setInterval(() => {}, 1000);
  `);
  const command = `"${process.execPath}" "${script}"`;
  let unrelated;
  try {
    let pulses = 0; const ticker = setInterval(() => pulses++, 10);
    try { assert.equal(await runDshAsync({ command, args: ['slow'], timeoutMs: 5000 }), 'done\n'); }
    finally { clearInterval(ticker); }
    assert(pulses >= 5, 'Extension event loop remains responsive while a command is running');
    await assert.rejects(runDshAsync({ command, args: ['fail'] }), error => error.code === 'EPROCESS' && error.exitCode === 7 && /fixture failed/.test(error.message));
    await assert.rejects(runDshAsync({ command, args: ['hang'], timeoutMs: 100 }), error => error.code === 'ETIMEDOUT');
    const pre = new AbortController(); pre.abort();
    await assert.rejects(runDshAsync({ command, args: ['slow'], signal: pre.signal }), error => error.code === 'ECANCELLED');
    unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    await once(unrelated, 'spawn');
    await realExitedLaunchers(script, unrelated);
    let ownedPid;
    const abort = new AbortController();
    const running = runDshAsync({ command, args: ['tree'], signal: abort.signal, onOutput: ({ text }) => {
      if (text.startsWith('child=')) { ownedPid = Number(text.slice(6)); abort.abort(); }
    } });
    await assert.rejects(running, error => error.code === 'ECANCELLED');
    assert(ownedPid > 0, 'A real child process was started');
    for (let attempt = 0; attempt < 20 && exists(ownedPid); attempt++) await wait(50);
    assert.equal(exists(ownedPid), false, 'Cancellation stops this invocation and its descendants');
    assert.equal(exists(unrelated.pid), true, 'Cancellation leaves unrelated processes running');
    const lines = [];
    await runDshAsync({ command, args: ['secret'], onOutput: item => lines.push(item.text) });
    assert(!lines.join('\n').includes('test-secret'), 'Output is redacted across stream chunk boundaries');
    await assert.rejects(runDshAsync({ command, args: ['secret-fail'] }), error => {
      assert.equal(error.code, 'EPROCESS');
      assert(!error.message.includes('fixture-secret-marker'), 'Redact complete output before truncating error details inside a credential');
      assert(error.message.includes('[已隐藏]'), 'Useful redacted error details remain available');
      return true;
    });
    console.log('Async commands: responsiveness, success, spaced paths, nonzero exit, timeout, cancellation, process ownership and output redaction passed');
  } finally { if (unrelated) { const closed = once(unrelated, 'close'); unrelated.kill(); await closed; } fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
