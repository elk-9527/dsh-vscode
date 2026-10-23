'use strict';
const path = require('node:path');
const { snapshotMessage } = require('./queue');
const QUEUE_KEY = 'dshPanel.queue.v1';
const QUEUE_BYTES = 3 * 1024 * 1024;
const QUEUE_TTL = 7 * 86400000;
const QUEUE_LIMIT = 5;
/** @typedef {import('./queue').QueueEntry} QueueEntry */
/** @typedef {{get: (key: string) => unknown, update: (key: string, value: unknown) => unknown}} QueueStorage */

/** A separate budget from the 512 KiB composer draft; never truncate accepted items. */
/** @param {unknown} value @param {{now?: number}} [options]
 * @returns {{items: QueueEntry[], paused: boolean, reason: string} | undefined} */
function normalizeQueue(value, { now = Date.now() } = {}) {
  if (value === undefined) return undefined;
  /** @returns {never} */
  function invalid() { throw new Error('待发送消息的恢复记录损坏或已过期。原记录已保留，请核对后明确放弃旧恢复记录。'); }
  if (!value || typeof value !== 'object') invalid();
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.version !== 1 || !Array.isArray(record.items) || record.items.length > QUEUE_LIMIT
    || typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt) || record.savedAt > now + 60000 || now - record.savedAt > QUEUE_TTL
    || Buffer.byteLength(JSON.stringify(record)) > QUEUE_BYTES) invalid();
  const ids = new Set(), requests = new Set();
  const items = /** @type {unknown[]} */ (record.items).map(raw => {
    if (!raw || typeof raw !== 'object') invalid();
    const item = /** @type {Record<string, unknown>} */ (raw);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)
      || typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd) || item.cwd.includes('\0')
      || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 512
      || item.requestDigest !== undefined && (typeof item.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestDigest))
      || item.instanceId !== undefined && (typeof item.instanceId !== 'string' || item.instanceId.length > 512)
      || typeof item.phase !== 'string' || !['waiting', 'running', 'uncertain'].includes(item.phase)
      || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt > now + 60000 || now - item.createdAt > QUEUE_TTL
      || item.requestId !== undefined && !(typeof item.requestId === 'string' && item.requestId.length <= 512 || typeof item.requestId === 'number' && Number.isFinite(item.requestId))) invalid();
    if (item.requestId !== undefined && requests.has(item.requestId)) invalid();
    ids.add(item.id); requests.add(item.requestId);
    let draft;
    if (typeof item.text !== 'string' || !Array.isArray(item.attachments)) invalid();
    try { draft = snapshotMessage(item.text, item.attachments); } catch { invalid(); }
    const uncertain = item.phase === 'running' || item.phase === 'uncertain';
    return Object.freeze({ id: item.id, requestId: item.requestId, cwd: item.cwd, sessionId: item.sessionId,
      instanceId: /** @type {string | undefined} */ (item.instanceId), requestDigest: /** @type {string | undefined} */ (item.requestDigest), createdAt: item.createdAt, ...draft, restored: true, uncertain,
      phase: uncertain ? 'uncertain' : 'waiting', ...(uncertain ? { failed: true, reason: '执行结果待确认，请先核对历史记录；不会自动重发。' } : {}) });
  });
  return { items, paused: items.length > 0, reason: items.some(item => item.uncertain)
    ? '执行结果待确认，请核对历史后取回编辑。其他恢复消息保持暂停。' : '已恢复待发送消息，请确认目录、会话与工作区信任后显式继续或取回编辑。' };
}

class QueuePersistence {
  /** @param {QueueStorage | undefined} storage @param {{now?: () => number}} [options] */
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage; this.now = now;
    /** @type {Promise<unknown>} */ this.writes = Promise.resolve();
  }
  load() { return normalizeQueue(this.storage?.get(QUEUE_KEY), { now: this.now() }); }
  /** @param {{items: QueueEntry[], active?: QueueEntry}} queue */
  save(queue) {
    if (!this.storage?.update) return Promise.reject(new Error('待发送消息存储不可用，消息尚未接收。'));
    /** @param {QueueEntry} item @param {'running' | 'waiting'} phase @returns {QueueEntry} */
    const describe = (item, phase) => ({ id: item.id, requestId: item.requestId, text: item.text, attachments: item.attachments,
      cwd: item.cwd, sessionId: item.sessionId, instanceId: item.instanceId, requestDigest: item.requestDigest, createdAt: item.createdAt,
      phase: item.uncertain ? 'uncertain' : phase });
    const value = { version: 1, savedAt: this.now(), items: [
      ...(queue.active ? [describe(queue.active, 'running')] : []), ...queue.items.map(item => describe(item, 'waiting')),
    ] };
    if (value.items.length > QUEUE_LIMIT || Buffer.byteLength(JSON.stringify(value)) > QUEUE_BYTES) return Promise.reject(new Error('待发送消息存储超过 5 条或 3 MiB 上限，请取回已有消息后重试。'));
    try { normalizeQueue(value, { now: this.now() }); } catch (error) { return Promise.reject(error); }
    const copy = structuredClone(value);
    const storage = this.storage;
    const next = this.writes.catch(() => {}).then(() => storage.update(QUEUE_KEY, copy));
    this.writes = next; return next;
  }
  discard() {
    if (!this.storage?.update) return Promise.reject(new Error('待发送消息存储不可用。'));
    const storage = this.storage;
    const next = this.writes.catch(() => {}).then(() => storage.update(QUEUE_KEY, undefined)); this.writes = next; return next;
  }
}

module.exports = { QueuePersistence, normalizeQueue, QUEUE_KEY, QUEUE_BYTES, QUEUE_LIMIT, QUEUE_TTL };
