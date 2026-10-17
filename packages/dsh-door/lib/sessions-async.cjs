'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const unzip = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : undefined;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_BYTES = 64 * 1024 * 1024;
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
/** 仅缓存摘要；文件身份或修改时间变化时重新解读，不保留对话正文。 */
function createAsyncHistory({ summarizeSession, sessionTranscript, historyOptions, historyPage, pageMetadata, SESSION_FILE }) {
  const cache = new Map(); let cacheBytes = 0;
  const check = signal => signal?.throwIfAborted();
  async function files(root, signal) {
    check(signal); const found = [];
    let groups;
    try { groups = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    for (const group of groups) {
      check(signal); if (!group.isDirectory()) continue;
      let entries; try { entries = await fs.readdir(path.join(root, group.name), { withFileTypes: true }); } catch { continue; }
      for (let i = 0; i < entries.length; i += 16) {
        check(signal);
        await Promise.all(entries.slice(i, i + 16).filter(entry => entry.isDirectory()).map(async entry => {
          const file = path.join(root, group.name, entry.name, SESSION_FILE);
          try { const st = await fs.stat(file); if (st.isFile()) found.push({ file, mtime: st.mtimeMs, size: st.size, dirName: entry.name, key: `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}` }); } catch {}
        }));
      }
    }
    check(signal); return found.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  }
  async function decode(item, signal) {
    check(signal);
    if (!unzip) return { events: [], error: '读不了这个会话文件（这台机器的运行环境不支持这种压缩）' };
    if (item.size > MAX_BYTES) return { events: [], error: '会话文件太大，跳过解读' };
    const buf = await fs.readFile(item.file, { signal }); check(signal);
    if (buf.length > MAX_BYTES) return { events: [], error: '会话文件太大，跳过解读' };
    const starts = []; for (let at = buf.indexOf(MAGIC); at >= 0; at = buf.indexOf(MAGIC, at + 4)) starts.push(at);
    const texts = []; let bad = 0, bytes = 0;
    for (let i = 0; i < starts.length; i++) {
      check(signal);
      let decoded; try { decoded = await unzip(buf.subarray(starts[i], starts[i + 1] ?? buf.length), { maxOutputLength: MAX_BYTES }); } catch { bad++; continue; }
      bytes += decoded.length; if (bytes > MAX_BYTES) return { events: [], error: '会话解压后太大，跳过解读' };
      texts.push(decoded.toString('utf8'));
    }
    const events = [], lines = texts.join('').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i % 128 === 0) { await yieldTurn(); check(signal); }
      try { const value = JSON.parse(lines[i]); if (value && typeof value === 'object') events.push(value); } catch {}
    }
    return { events, error: bad ? `${bad} 个坏帧被跳过` : undefined };
  }
  async function card(item, signal) {
    check(signal); const held = cache.get(item.file);
    if (held?.key === item.key) { cache.delete(item.file); cache.set(item.file, held); return { ...held.card }; }
    if (held) { cacheBytes -= held.bytes; cache.delete(item.file); }
    let decoded; try { decoded = await decode(item, signal); } catch (error) { check(signal); decoded = { events: [], error: `读不了会话文件：${error.message}` }; }
    const result = summarizeSession(decoded.events, item); delete result.file;
    if (!result.id) result.id = item.dirName; if (decoded.error) result.decodeError = decoded.error;
    const st = await fs.stat(item.file).catch(() => undefined);
    check(signal);
    if (!decoded.error && st && `${st.dev}:${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}` === item.key) {
      const bytes = Buffer.byteLength(JSON.stringify(result));
      // Other searches may have filled this entry while the file was decoding.
      const previous = cache.get(item.file); if (previous) cacheBytes -= previous.bytes;
      cache.set(item.file, { key: item.key, card: result, bytes }); cacheBytes += bytes;
      while (cache.size > 16384 || cacheBytes > 8 * 1024 * 1024) { const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest); }
    }
    return { ...result };
  }
  async function listSessionsAsync(root, params = {}) {
    const signal = params.signal, options = historyOptions(params);
    const found = await files(root, signal);
    const present = new Set(found.map(item => item.file));
    for (const [file, held] of cache) if (path.relative(root, file).startsWith('..') === false && !present.has(file)) { cacheBytes -= held.bytes; cache.delete(file); }
    const filtering = Boolean(options.query || options.cwd);
    const taken = filtering ? found : found.slice(options.offset, options.offset + options.limit), cards = [];
    for (let i = 0; i < taken.length; i += 4) { check(signal); cards.push(...await Promise.all(taken.slice(i, i + 4).map(item => card(item, signal)))); await yieldTurn(); }
    return filtering ? historyPage(cards, options) : pageMetadata(cards, found.length, options);
  }
  async function getSessionAsync(root, id, options = {}) {
    const wanted = String(id || ''); if (!/^[A-Za-z0-9._-]+$/.test(wanted)) throw new Error('会话 id 不合法');
    const found = await files(root, options.signal);
    let item = found.find(item => [wanted, `session-${wanted}`].includes(item.dirName) || `session-${item.dirName}` === wanted);
    if (!item) for (const candidate of found) if ((await card(candidate, options.signal)).id === wanted) { item = candidate; break; }
    if (!item) throw new Error(`找不到会话 ${wanted}`);
    const decoded = await decode(item, options.signal), result = summarizeSession(decoded.events, item); delete result.file;
    if (decoded.error) result.decodeError = decoded.error;
    check(options.signal); return { card: result, ...sessionTranscript(decoded.events, options) };
  }
  return { listSessionsAsync, getSessionAsync };
}
module.exports = { createAsyncHistory };
