'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MAX_REPORT = 1024 * 1024, MAX_FILE = 2 * 1024 * 1024;
const keyOf = value => createHash('sha256').update(value).digest('hex');
const digest = value => keyOf(JSON.stringify(value));
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => { throw new Error(message); };

/** Immutable local reports and per-case evidence; no credentials or live handles. */
class ReportStore {
  constructor({ directory, maxBytes = 32 * 1024 * 1024, maxReports = 100 } = {}) {
    this.directory = directory && path.resolve(directory);
    this.maxBytes = maxBytes; this.maxReports = maxReports; this.protected = new Set();
    this.pending = Promise.resolve(); this.pins = new Map();
  }
  key(op) {
    if (typeof op?.id !== 'string' || !op.id || op.id.length > 256 || typeof op.cwd !== 'string' || !path.isAbsolute(op.cwd)) fail('报告归属无效。');
    return keyOf(JSON.stringify([identity(op.cwd), op.instanceId || '', op.clientId || '', op.originalOperationId || op.id]));
  }
  serialize(action) {
    const next = this.pending.catch(() => {}).then(() => this.locked(action)); this.pending = next; return next;
  }
  async locked(action) {
    await this.ready();
    const id = randomUUID(), owner = { pid: process.pid, id };
    const choosing = path.join(this.directory, `.choosing.${process.pid}.${id}`);
    const claim = path.join(this.directory, `.writer.${process.pid}.${id}`);
    const pattern = /^\.(choosing|writer)\.(\d+)\.([a-f0-9-]{36})$/;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
    const deadline = Date.now() + 5000;
    const scanClaims = async () => {
      const result = [];
      for (const name of await fs.readdir(this.directory)) {
        const match = pattern.exec(name); if (!match) continue;
        if (!alive(Number(match[2]))) { await fs.unlink(path.join(this.directory, name)).catch(() => {}); continue; }
        if (match[1] === 'choosing') { result.push({ choosing: true, id: match[3] }); continue; }
        try {
          const value = await this.readFile(path.join(this.directory, name));
          if (value.id !== match[3] || value.pid !== Number(match[2]) || !Number.isSafeInteger(value.ticket) || value.ticket < 1) fail('结果存储锁无效。');
          result.push(value);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return result;
    };
    // Retry only complete ticket scans; failed scans never yield partial claims.
    const claims = async () => {
      while (true) {
        try { return await scanClaims(); }
        catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
          if (Date.now() >= deadline) throw error;
        }
      }
    };
    await fs.writeFile(choosing, '', { flag: 'wx', mode: 0o600 });
    try {
      // Choosing markers prevent a partly selected ticket from being overtaken.
      owner.ticket = Math.max(0, ...(await claims()).filter(value => !value.choosing).map(value => value.ticket)) + 1;
      if (!Number.isSafeInteger(owner.ticket)) fail('结果存储锁超限。');
      await fs.writeFile(choosing, JSON.stringify(owner)); await fs.link(choosing, claim); await fs.unlink(choosing);
      while (Date.now() < deadline) {
        const others = (await claims()).filter(value => value.id !== id);
        if (Date.now() >= deadline) break;
        let busy = others.some(value => value.choosing || value.ticket < owner.ticket || value.ticket === owner.ticket && value.id < id);
        if (!busy) return await action();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      fail('另一个窗口正在保存结果，请稍后重试。');
    } finally {
      for (const file of [claim, choosing]) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async ready() {
    if (!this.directory) fail('当前工作区没有本地结果存储。');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('结果存储位置无效。');
  }
  async importLegacy(directory) {
    if (!this.directory || path.resolve(directory) === this.directory) return;
    try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return; }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    return this.serialize(async () => {
      const marker = path.join(this.directory, '.legacy-v1-imported');
      try { await fs.access(marker); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const pendingFile = path.join(this.directory, '.legacy-v1-pending.json');
      let pending;
      try { pending = await this.readFile(pendingFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pending && (!Array.isArray(pending.names) || pending.names.some(name => !/^[a-f0-9]{64}(?:\.[a-f0-9-]{36})?\.json$/.test(name)))) fail('早期报告导入清单无效，原文件保留。');
      // The old storage remains untouched; only quiescent immutable evidence is imported.
      for (const name of await fs.readdir(directory)) {
        if (name === '.write-lock') {
          const value = await this.readFile(path.join(directory, name));
          try { process.kill(value.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
        }
        const match = /^\.(?:writer|choosing)\.(\d+)\.[a-f0-9-]{36}$/.exec(name);
        if (match) { try { process.kill(Number(match[1]), 0); return; } catch (error) { if (error.code !== 'ESRCH') return; } }
      }
      if (!pending && (await this.files()).length) return;
      const legacy = new ReportStore({ directory });
      const reports = (await legacy.list()).map(value => ({ ...value, caseKey: value.caseKey || value.key })).sort((a, b) => Number(a.caseKey !== a.key) - Number(b.caseKey !== b.key));
      const roots = new Set(reports.filter(value => value.caseKey === value.key).map(value => value.key));
      const values = reports.filter(value => roots.has(value.caseKey));
      for (const key of roots) values.push(...await legacy.events(key));
      const names = values.map(value => path.basename(value.kind === 'review' ? this.file(value.key) : this.file(value.caseKey, value.id)));
      if (pending && (pending.names.length !== names.length || pending.names.some(name => !names.includes(name)))) fail('早期报告来源已变化，导入尚未完成，原文件保留。');
      const existing = (await this.files()).filter(file => !names.includes(file.name));
      if (existing.reduce((bytes, file) => bytes + file.bytes, 0) + values.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0) > this.maxBytes || existing.filter(file => file.name.length === 69).length + reports.length > this.maxReports) fail('早期报告超出当前存储预算，原文件保留。');
      if (!pending) {
        const temporary = path.join(this.directory, `.${randomUUID()}.import`);
        try { await fs.writeFile(temporary, JSON.stringify({ names }), { flag: 'wx', mode: 0o600 }); await fs.link(temporary, pendingFile); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      }
      // Import references are fixed before writing, so a failed or interrupted copy can resume.
      for (const [index, value] of values.entries()) {
        const file = path.join(this.directory, names[index]);
        try { if (digest(await this.readFile(file)) !== digest(value)) fail('导入目标已有不同正文，未覆盖原文件。'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await this.commit(file, value, value.caseKey, true); }
      }
      await fs.writeFile(marker, '', { flag: 'wx', mode: 0o600 });
      await fs.unlink(pendingFile).catch(() => {});
    });
  }
  async migrationPending(key) {
    if (!this.directory) return false;
    try { await fs.access(path.join(this.directory, '.legacy-v1-imported')); return false; } catch (error) { if (error.code !== 'ENOENT') return true; }
    try { const value = await this.readFile(path.join(this.directory, '.legacy-v1-pending.json')); return !Array.isArray(value.names) || value.names.some(name => typeof name !== 'string' || !key || name.startsWith(key)); }
    catch (error) { return error.code !== 'ENOENT'; }
  }
  file(key, suffix = '') {
    if (!validKey(key) || suffix && !/^[a-f0-9-]{36}$/.test(suffix)) fail('结果标识无效。');
    return path.join(this.directory, suffix ? `${key}.${suffix}.json` : `${key}.json`);
  }
  async readFile(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) fail('结果文件无效或过大。');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_FILE) fail('结果文件已变化。');
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text) > MAX_FILE) fail('结果文件过大。');
      return JSON.parse(text);
    } finally { await handle.close(); }
  }
  validate(value, key) {
    if (value?.schemaVersion !== 1 || value.kind !== 'review' || value.key !== key || !value.operation ||
        this.key(value.operation) !== key || !['completed', 'failed', 'cancelled'].includes(value.operation.status) ||
        !value.report || typeof value.report !== 'object' || Array.isArray(value.report) || value.reportDigest !== digest(value.report) ||
        Buffer.byteLength(JSON.stringify(value.report)) > MAX_REPORT || value.caseKey && !validKey(value.caseKey)) fail('报告格式或摘要无效。');
    return value;
  }
  async read(key) {
    await this.ready(); return this.validate(await this.readFile(this.file(key)), key);
  }
  async list() {
    if (!this.directory) return [];
    await this.ready(); const records = [];
    for (const name of (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      try { records.push(await this.read(name.slice(0, 64))); } catch { /* One damaged record must not block other history. */ }
    }
    return records.sort((a, b) => String(b.operation.finishedAt || b.operation.startedAt).localeCompare(String(a.operation.finishedAt || a.operation.startedAt))).slice(0, this.maxReports);
  }
  async files() {
    const records = [];
    for (const name of await fs.readdir(this.directory)) if (/^[a-f0-9]{64}(?:\.[a-f0-9-]{36})?\.json$/.test(name)) {
      const stat = await fs.lstat(path.join(this.directory, name));
      if (!stat.isSymbolicLink() && stat.isFile()) records.push({ name, bytes: stat.size, time: stat.mtimeMs, key: name.slice(0, 64) });
    }
    return records;
  }
  async pin(key, owner) {
    if (!this.directory || !validKey(key)) return;
    return this.serialize(async () => {
      await this.ready(); const id = `${key}:${owner}`;
      if (this.pins.has(id)) return;
      await this.read(key);
      const file = path.join(this.directory, `${key}.${process.pid}.${randomUUID()}.pin`);
      await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 }); this.pins.set(id, file);
    });
  }
  async unpin(key, owner) {
    if (!this.directory) return;
    return this.serialize(async () => {
      const id = `${key}:${owner}`, file = this.pins.get(id);
      if (file) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.pins.delete(id);
    });
  }
  async protectedKeys() {
    const keys = new Set(this.protected);
    if (await this.migrationPending()) {
      try { for (const name of (await this.readFile(path.join(this.directory, '.legacy-v1-pending.json'))).names || []) if (typeof name === 'string' && validKey(name.slice(0, 64))) keys.add(name.slice(0, 64)); } catch { /* A damaged migration index never deletes other valid history. */ }
    }
    for (const name of await fs.readdir(this.directory)) {
      const match = /^([a-f0-9]{64})\.(\d+)\.[a-f0-9-]{36}\.pin$/.exec(name); if (!match) continue;
      try { process.kill(Number(match[2]), 0); keys.add(match[1]); }
      catch (error) { if (error.code === 'ESRCH') await fs.unlink(path.join(this.directory, name)).catch(() => {}); else keys.add(match[1]); }
    }
    return keys;
  }
  async room(bytes, protectedKey, addingReport) {
    const files = await this.files(); let total = files.reduce((sum, file) => sum + file.bytes, 0);
    let reports = files.filter(file => file.name.length === 69).length;
    if (total > this.maxBytes || reports > this.maxReports) fail('上次空间清理未完成，请先清理已结束记录。');
    const victims = [];
    const keys = await this.protectedKeys(), parents = new Map(), groups = new Map(); keys.add(protectedKey);
    for (const file of files.filter(item => item.name.length === 69)) {
      try { parents.set(file.key, (await this.read(file.key)).caseKey || file.key); } catch { parents.set(file.key, file.key); }
    }
    for (const key of [...keys]) keys.add(parents.get(key) || key);
    for (const file of files) {
      const key = parents.get(file.key) || file.key;
      const group = groups.get(key) || { key, files: [], time: file.time };
      group.files.push(file); group.time = Math.min(group.time, file.time); groups.set(key, group);
    }
    for (const group of [...groups.values()].sort((a, b) => a.time - b.time)) {
      if (total + bytes <= this.maxBytes && (!addingReport || reports < this.maxReports)) break;
      if (keys.has(group.key) || group.files.some(file => keys.has(file.key))) continue;
      for (const file of group.files) {
        victims.push(file); total -= file.bytes;
        if (file.name.length === 69) reports--;
      }
    }
    if (total + bytes > this.maxBytes || addingReport && reports >= this.maxReports) fail('本地结果空间不足，请清理已结束记录。');
    return victims;
  }
  async commit(file, value, protectedKey, preflighted = false) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FILE) fail('结果超过保存大小限制。');
    const victims = preflighted ? [] : await this.room(Buffer.byteLength(text), value.caseKey || protectedKey, value.kind === 'review');
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      const checked = await this.readFile(temporary);
      if (digest(checked) !== digest(value)) fail('结果回读核对未通过。');
      await fs.link(temporary, file);
      // Reclaim only after the replacement is durably committed. A failed write keeps all old evidence.
      for (const victim of victims) await fs.unlink(path.join(this.directory, victim.name)).catch(error => { if (error.code !== 'ENOENT') this.cleanupPending = true; });
    } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') this.cleanupPending = true; }); }
  }
  async save(op, report, source = {}) {
    return this.serialize(async () => {
      await this.ready(); const key = this.key(op), file = this.file(key);
      if (!report || typeof report !== 'object' || Array.isArray(report) || Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT) fail('报告内容无效或超限。');
      try {
        const existing = await this.read(key);
        if (existing.reportDigest !== digest(report) || existing.operation.fingerprint !== op.fingerprint) fail('相同运行已有不同结果，未覆盖原报告。');
        return { key, caseKey: existing.caseKey, savedAt: existing.savedAt };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const input = op.input && { mode: op.input.mode, ...(op.input.ref ? { ref: op.input.ref } : {}) };
      const operation = { id: op.originalOperationId || op.id, cwd: op.cwd, status: op.status, fingerprint: op.fingerprint,
        fingerprintVersion: 'git-disk-v1', instanceId: op.instanceId, clientId: op.clientId, input,
        requestedRef: op.requestedRef, startedAt: op.startedAt, finishedAt: op.finishedAt, retryOf: op.retryOf };
      if (op.caseKey && op.caseKey !== key) await this.read(op.caseKey);
      const value = { schemaVersion: 1, kind: 'review', key, caseKey: validKey(op.caseKey) ? op.caseKey : key,
        savedAt: new Date().toISOString(), operation, source: { panel: source.panel, door: source.door, runtime: source.runtime, provider: source.provider },
        completeness: Array.isArray(report.findings) && op.status === 'completed' ? 'structured' : 'incomplete',
        reportDigest: digest(report), report: JSON.parse(JSON.stringify(report)),
        scopeNote: '磁盘 Git 范围；不包含未保存的编辑器修改。实际审查模型未由提供方确认。' };
      this.validate(value, key);
      try { await this.commit(file, value, key); }
      catch (error) { if (error.code !== 'EEXIST') throw error; const other = await this.read(key); if (other.reportDigest !== value.reportDigest || other.operation.fingerprint !== value.operation.fingerprint) fail('并发报告内容不一致。'); }
      const saved = await this.read(key); return { key, caseKey: saved.caseKey, savedAt: saved.savedAt };
    });
  }
  async append(caseKey, event) {
    return this.serialize(async () => {
      await this.ready();
      if (!validKey(caseKey) || !['fix', 'test', 'review', 'log'].includes(event?.kind)) fail('任务证据归属无效。');
      await this.read(caseKey);
      const id = event.id || randomUUID();
      if (!/^[a-f0-9-]{36}$/.test(id)) fail('执行证据标识无效。');
      const payload = JSON.parse(JSON.stringify(event));
      const seq = (await this.events(caseKey)).reduce((maximum, value) => Math.max(maximum, value.seq || 0), 0) + 1;
      const value = { schemaVersion: 1, kind: 'evidence', caseKey, id, seq, at: event.at || new Date().toISOString(), payload, payloadDigest: digest(payload) };
      await this.commit(this.file(caseKey, id), value, caseKey); return value;
    });
  }
  async events(caseKey) {
    if (!this.directory || !validKey(caseKey)) return [];
    await this.ready(); const result = [];
    for (const name of (await fs.readdir(this.directory)).filter(name => name.startsWith(caseKey + '.') && new RegExp(`^${caseKey}\\.[a-f0-9-]{36}\\.json$`).test(name))) {
      try {
        const value = await this.readFile(path.join(this.directory, name));
        if (value.schemaVersion === 1 && value.kind === 'evidence' && value.caseKey === caseKey && name === `${caseKey}.${value.id}.json` &&
          ['fix', 'test', 'review', 'log'].includes(value.payload?.kind) && (value.seq === undefined || Number.isSafeInteger(value.seq) && value.seq > 0) && typeof value.at === 'string' && value.payloadDigest === digest(value.payload)) result.push(value);
      } catch { /* Keep incomplete evidence separate from valid records. */ }
    }
    return result.sort((a, b) => (a.seq || 0) - (b.seq || 0) || a.at.localeCompare(b.at));
  }
  async remove(key) {
    if (!this.directory || !validKey(key)) return false;
    return this.serialize(async () => {
      await this.ready();
      const record = await this.read(key).catch(() => undefined), parent = record?.caseKey || key;
      const keys = await this.protectedKeys(); if (keys.has(key) || keys.has(parent)) return false;
      if (key === parent && (await this.list()).some(item => item.key !== key && item.caseKey === key)) return false;
      for (const file of await this.files()) if (file.key === key) await fs.unlink(path.join(this.directory, file.name));
      return true;
    });
  }
  async dispose() { if (this.directory) await this.serialize(async () => { for (const file of this.pins.values()) await fs.unlink(file).catch(() => {}); this.pins.clear(); }); }
}
module.exports = { ReportStore, MAX_REPORT, MAX_FILE, validKey, digest };
