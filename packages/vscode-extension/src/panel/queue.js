'use strict';
const { randomUUID } = require('node:crypto');

function attachmentMetadata(item) {
  const result = {};
  for (const key of ['kind', 'id', 'name', 'language', 'detail', 'finishedAt', 'sourceUri', 'sourcePath', 'scope', 'snapshotAt', 'source', 'turnId', 'testId']) if (typeof item[key] === 'string') result[key] = item[key].slice(0, 4096);
  for (const key of ['startLine', 'endLine', 'rangeEndLine']) if (Number.isInteger(item[key]) && item[key] > 0) result[key] = item[key];
  for (const key of ['startCharacter', 'endCharacter', 'documentVersion', 'byteLength']) if (Number.isInteger(item[key]) && item[key] >= 0) result[key] = item[key];
  for (const key of ['isDirty', 'isUntitled']) if (typeof item[key] === 'boolean') result[key] = item[key];
  return result;
}

function snapshotMessage(text, attachments = []) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new Error('消息正文需为文本，且不超过 256 KiB。');
  if (!Array.isArray(attachments) || attachments.length > 20) throw new Error('最多附加 20 项。');
  let bytes = 0;
  const items = attachments.filter(Boolean).map(item => {
    if (typeof item !== 'object' || typeof item.text !== 'string' || item.text.includes('\0')) throw new Error('附件需包含可读取的文本快照。');
    bytes += Buffer.byteLength(item.text);
    if (bytes > 256 * 1024) throw new Error('附件正文总量不超过 256 KiB。');
    // Queued files must use the accepted editor snapshot, rather than reading a
    // resource link after the working tree has changed.
    const result = { ...attachmentMetadata(item), text: item.text, byteLength: Buffer.byteLength(item.text, 'utf8') };
    if (result.kind === 'file') result.kind = 'content';
    return Object.freeze(result);
  });
  if (!text.trim() && !items.length) throw new Error('请先输入消息或添加附件。');
  return Object.freeze({ text, attachments: Object.freeze(items) });
}

/** In-memory pending messages belong to their original session and directory. */
class MessageQueue {
  constructor({ onChange = () => {}, limit = 5 } = {}) { this.items = []; this.active = undefined; this.paused = false; this.reason = ''; this.onChange = onChange; this.limit = limit; }
  add(draft, binding, requestId) {
    if (this.items.length + Number(Boolean(this.active)) >= this.limit) throw new Error('最多保留 5 条待处理消息，请先处理已有消息。');
    const entry = Object.freeze({ id: randomUUID(), requestId, ...draft, ...binding });
    this.items.push(entry); this.onChange(); return entry;
  }
  pause(reason) { this.paused = true; this.reason = reason; this.onChange(); }
  resume() { this.paused = false; this.reason = ''; this.onChange(); }
  remove(id) {
    const index = this.items.findIndex(item => item.id === id); if (index < 0) return;
    const [entry] = this.items.splice(index, 1);
    try { this.onChange(); }
    catch (error) { this.items.splice(index, 0, entry); throw error; }
    return entry;
  }
  take() { if (this.active || this.paused) return; this.active = this.items.shift(); this.onChange(); return this.active; }
  finish(failure) { if (failure && this.active) this.items.unshift(Object.freeze({ ...this.active, failed: true, reason: failure })); this.active = undefined; this.onChange(); }
  state() {
    const describe = item => ({ id: item.id, requestId: item.requestId, text: item.text, attachments: item.attachments, attachmentCount: item.attachments.length, cwd: item.cwd, sessionId: item.sessionId, ...(item.failed ? { failed: true, reason: item.reason } : {}) });
    return { type: 'queueState', paused: this.paused, reason: this.reason, items: this.items.map(describe), ...(this.active ? { active: describe(this.active) } : {}) };
  }
}
module.exports = { MessageQueue, snapshotMessage, attachmentMetadata };
