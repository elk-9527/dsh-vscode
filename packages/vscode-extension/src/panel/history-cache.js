'use strict';
const { historyOptions } = require('../dsh/history-query');
const CACHE_KEY = 'dshPanel.historySummaries.v1';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const CACHE_BYTES = 512 * 1024;

/** Cache exact list scopes only; no conversation bodies or live-history claims. */
class HistorySummaryCache {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage; this.now = now; this.entries = new Map(); this.writes = Promise.resolve();
    const saved = storage?.get(CACHE_KEY);
    if (saved?.version === 1 && Array.isArray(saved.entries) && saved.entries.length <= 8
      && Buffer.byteLength(JSON.stringify(saved)) <= CACHE_BYTES) {
      for (const item of saved.entries) if (typeof item?.key === 'string' && Number.isFinite(item.at) && item.at <= now() + 60000
        && now() - item.at <= CACHE_TTL && Array.isArray(item.result?.sessions) && item.result.sessions.length <= 500) this.entries.set(item.key, item);
    }
  }
  key(source, options) { return JSON.stringify([source, historyOptions(options)]); }
  get(source, options) {
    const item = this.entries.get(this.key(source, options));
    if (!item || this.now() - item.at > CACHE_TTL) return;
    return { ...structuredClone(item.result), limited: true, cachedAt: item.at, cacheScope: historyOptions(options),
      limitation: '当前无法获取完整历史，显示最近成功查询的只读摘要缓存；仅覆盖当时的筛选与分页范围，可能包含已删除的会话。' };
  }
  async put(source, options, result) {
    if (!Array.isArray(result?.sessions)) return;
    const sessions = result.sessions.slice(0, 500).map(card => {
      const item = {};
      for (const key of ['id', 'title', 'fallbackTitle', 'cwd', 'preset', 'decodeError']) if (typeof card[key] === 'string') item[key] = card[key].slice(0, key === 'cwd' ? 4096 : 2048);
      for (const key of ['createdAt', 'lastTime', 'turns', 'userMessages', 'mtime', 'size']) if (Number.isFinite(card[key])) item[key] = card[key];
      if (card.summaryPartial === true) item.summaryPartial = true;
      return item;
    }).filter(card => card.id);
    const value = { sessions };
    for (const key of ['total', 'offset', 'skipped', 'nextOffset']) if (Number.isFinite(result[key])) value[key] = result[key];
    const key = this.key(source, options); this.entries.delete(key);
    this.entries.set(key, { key, at: this.now(), result: value });
    while (this.entries.size > 8 || Buffer.byteLength(JSON.stringify([...this.entries.values()])) > CACHE_BYTES - 128) {
      if (!this.entries.size) break; this.entries.delete(this.entries.keys().next().value);
    }
    if (this.storage?.update) {
      const snapshot = { version: 1, entries: structuredClone([...this.entries.values()]) };
      this.writes = this.writes.catch(() => {}).then(() => this.storage.update(CACHE_KEY, snapshot)); await this.writes;
    }
  }
}
module.exports = { HistorySummaryCache, CACHE_KEY, CACHE_TTL };
