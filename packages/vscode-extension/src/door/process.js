'use strict';

const { spawn } = require('node:child_process');
const ignoreError = () => {};

/** Stop only the process group created by this runner. No process-name matching. */
async function stopOwnedProcess(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // A completed launcher's PID can be reused. Its detached descendants cannot
    // safely be recovered by taskkill once that root process has finished.
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      let killer, timeout;
      const done = () => {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch {} }
        resolve();
      };
      try { killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
      catch { done(); return; }
      timeout = setTimeout(() => { try { killer.kill(); } catch {} done(); }, 10000);
      killer.once('error', done); killer.once('close', done);
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 500));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process group already finished. */ }
}

/** Async command execution with bounded output, cancellation and one owned process tree. */
function runCommand({ file, args = [], options = {}, timeoutMs = 120000, signal,
  onOutput, redact = String, maxOutputBytes = 1024 * 1024 }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('命令已取消'), { code: 'ECANCELLED' }));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { ...options, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    const output = { stdout: '', stderr: '' }, lines = { stdout: '', stderr: '' };
    let bytes = 0, stopped, killPromise, settled = false, spawnError;
    const stop = (code, message) => {
      if (stopped || settled) return;
      stopped = Object.assign(new Error(message), { code });
      killPromise = stopOwnedProcess(child);
      // Descendants can retain inherited pipes after the launcher exits. Do not
      // depend on its 'close' event to finish a cancelled or bounded command.
      void killPromise.then(() => finish(child.exitCode, child.signalCode),
        () => finish(child.exitCode, child.signalCode));
    };
    const abort = () => stop('ECANCELLED', '命令已取消');
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => stop('ETIMEDOUT', `命令执行超时（${timeoutMs} 毫秒）`), timeoutMs) : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const emitLine = (stream, line) => { if (onOutput && line) { try { onOutput({ stream, text: redact(line) }); } catch {} } };
    const read = (stream, chunk) => {
      if (stopped || settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { stop('EMAXBUFFER', '命令输出超过限制'); return; }
      output[stream] += chunk;
      lines[stream] += chunk;
      const complete = lines[stream].split(/\r?\n/); lines[stream] = complete.pop();
      for (const line of complete) emitLine(stream, line);
    };
    const readers = {};
    for (const stream of ['stdout', 'stderr']) {
      readers[stream] = chunk => read(stream, chunk);
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('data', readers[stream]);
      child[stream]?.on('error', ignoreError);
    }
    const onError = error => { spawnError = error; };
    const onClose = (exitCode, exitSignal) => {
      void Promise.resolve(killPromise).then(() => finish(exitCode, exitSignal),
        () => finish(exitCode, exitSignal));
    };
    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.off('error', onError); child.off('close', onClose);
      // Spawn, kill or pipe errors may already be queued. Keep only bounded,
      // state-free handlers after releasing the command's listeners.
      child.once('error', ignoreError);
      for (const stream of ['stdout', 'stderr']) {
        child[stream]?.off('data', readers[stream]);
        child[stream]?.off('error', ignoreError);
        child[stream]?.once('error', ignoreError);
        child[stream]?.destroy();
      }
      for (const stream of ['stdout', 'stderr']) emitLine(stream, lines[stream]);
      const error = stopped || spawnError || (exitCode === 0 ? undefined : Object.assign(new Error(`命令退出（${exitSignal || exitCode}）`), { code: 'EPROCESS' }));
      if (error) {
        // Truncating raw output can cut off the credential's field/header and
        // leave its suffix unrecognizable to the redactor.
        error.message = redact([error.message, redact(output.stderr).slice(-8192), redact(output.stdout).slice(-8192)].filter(Boolean).join('\n'));
        error.exitCode = exitCode; error.signal = exitSignal;
        reject(error);
      } else resolve(output.stdout);
    };
    child.once('error', onError);
    child.once('close', onClose);
  });
}

module.exports = { runCommand, stopOwnedProcess };
