'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
let environmentOwner;

function directorySize(directory) {
  let bytes = 0;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const item of entries) {
    const file = path.join(directory, item.name);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) continue;
    bytes += stat.isDirectory() ? directorySize(file) : stat.size;
  }
  return bytes;
}
function plainParents(file) {
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resource outside checkout');
  let current = ROOT;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Resource parent must not be a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function positive(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Resource limits must be positive integers');
  return number;
}

/** One process owns one fresh workspace; existing homes and candidate archives are references only. */
function createRunResources({ folder, label = 'run', keep = false, limits = {} } = {}) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid resource label');
  const parent = folder ? path.resolve(folder) : path.join(ROOT, 'build/runs');
  if (!path.relative(path.join(ROOT, 'build'), parent).startsWith('..') && parent !== ROOT) plainParents(parent);
  else throw new Error('Resources must be under build');
  const budget = {
    timeMs: positive(limits.timeMs ?? process.env.DSH_TEST_TIME_MS, 15 * 60 * 1000),
    bytes: positive(limits.bytes ?? process.env.DSH_TEST_MAX_BYTES, 2 * 1024 ** 3),
    outputBytes: positive(limits.outputBytes ?? process.env.DSH_TEST_OUTPUT_BYTES, 16 * 1024 ** 2),
    freeBytes: positive(limits.freeBytes ?? process.env.DSH_TEST_FREE_BYTES, 512 * 1024 ** 2),
  };
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, `${label}-`));
  const token = randomUUID(), marker = path.join(work, '.owner');
  fs.writeFileSync(marker, token, { flag: 'wx' });
  const started = Date.now();
  const remainingMs = () => Math.max(1, budget.timeMs - (Date.now() - started));
  const controller = new AbortController(), callbacks = [], ports = [], saved = new Map();
  let outputBytes = 0, closing, peakBytes = 0;
  const cancel = reason => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
  const check = () => {
    if (Date.now() - started >= budget.timeMs) cancel('Validation time limit exceeded');
    controller.signal.throwIfAborted();
    plainParents(work);
    const bytes = directorySize(work); peakBytes = Math.max(peakBytes, bytes);
    if (bytes > budget.bytes) cancel('Validation workspace space limit exceeded');
    if (fs.statfsSync) { const disk = fs.statfsSync(work); if (disk.bavail * disk.bsize < budget.freeBytes) cancel('Insufficient free space for validation'); }
    controller.signal.throwIfAborted();
  };
  const deadline = setTimeout(() => cancel('Validation time limit exceeded'), budget.timeMs); deadline.unref();
  const monitor = setInterval(() => { try { check(); } catch (error) { cancel(error.message); } }, 5000); monitor.unref();
  const signals = ['SIGINT', 'SIGTERM'].map(signal => { const handler = () => cancel(`Validation cancelled (${signal})`); process.on(signal, handler); return [signal, handler]; });
  const childEnv = (base = process.env) => {
    const tmp = path.join(work, 'tmp'), cache = path.join(work, 'cache');
    fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
    return { ...base, APPDATA: path.join(work, 'roaming'), LOCALAPPDATA: path.join(work, 'local'), TMP: tmp, TEMP: tmp, TMPDIR: tmp, npm_config_cache: path.join(cache, 'npm'),
      npm_config_store_dir: path.join(cache, 'pnpm'), PNPM_HOME: path.join(cache, 'pnpm-home'), XDG_CACHE_HOME: cache,
      DSH_PANEL_TEST_WORK: path.join(work, 'fixtures') };
  };
  const override = values => {
    if (environmentOwner && environmentOwner !== token) throw new Error('Concurrent runs must use child environments');
    environmentOwner = token;
    for (const [key, value] of Object.entries(values)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const guard = async action => {
    check();
    let abort;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      })]);
    } finally { if (abort) controller.signal.removeEventListener('abort', abort); }
  };
  const exit = () => {
    // Live resources need asynchronous disposal. Preserve them if the caller exits prematurely.
    if (callbacks.length || keep) return;
    try { plainParents(work); if (fs.readFileSync(marker, 'utf8') === token) fs.rmSync(work, { recursive: true, force: true }); } catch {}
  };
  process.once('exit', exit);
  const close = () => closing ||= (async () => {
    clearTimeout(deadline); clearInterval(monitor);
    for (const [signal, handler] of signals) process.off(signal, handler);
    process.off('exit', exit);
    const errors = [];
    for (const { name, dispose } of callbacks.reverse()) {
      let timer;
      try { await Promise.race([Promise.resolve().then(dispose), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disposal timeout')), 10000); })]); }
      catch (error) { errors.push(`${name}: ${error.message}`); }
      finally { clearTimeout(timer); }
    }
    for (const { port, probe } of ports) {
      try { if (await probe(port)) errors.push(`Owned port ${port} is still open`); } catch (error) { errors.push(error.message); }
    }
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (environmentOwner === token) environmentOwner = undefined;
    let bytes;
    try {
      plainParents(work);
      if (fs.readFileSync(marker, 'utf8') !== token) throw new Error('Resource ownership changed');
      bytes = directorySize(work); peakBytes = Math.max(peakBytes, bytes);
      if (!keep && !errors.length) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { errors.push(error.message); }
    return { status: errors.length ? 'failed' : 'passed', errors, bytes, peakBytes, outputBytes, limits: budget,
      retained: keep || errors.length > 0, reason: errors.length ? 'cleanup-failed' : keep ? 'explicit-keep-work' : 'rebuildable-work-removed',
      ...(controller.signal.aborted ? { abort: controller.signal.reason.message } : {}) };
  })();
  return { work, signal: controller.signal, remainingMs, check, guard, cancel, childEnv, override, close,
    child(child, name = 'child-process') {
      callbacks.push({ name, dispose: async () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        await require('../packages/vscode-extension/src/door/process').stopOwnedProcess(child);
        const end = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
        if (child.exitCode === null && child.signalCode === null) throw new Error('Owned process did not exit');
      } });
    },
    defer(name, dispose) { callbacks.push({ name, dispose }); },
    port(port, probe) { ports.push({ port, probe }); },
    appendLog(file, text) {
      const bytes = Buffer.byteLength(text); outputBytes += bytes;
      if (outputBytes > budget.outputBytes) { cancel('Validation output limit exceeded'); return; }
      fs.appendFileSync(file, text);
    },
  };
}
module.exports = { createRunResources, directorySize, plainParents };
