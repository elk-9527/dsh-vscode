'use strict';
const MAX_BYTES = 512 * 1024;
const TTL = 7 * 86400000;
const path = require('node:path');
const { attachmentMetadata } = require('./queue');
const { validateImageDescriptor, MAX_IMAGE_COUNT, MAX_MESSAGE_IMAGE_BYTES } = require('../dsh/images');
function workspaceIdentity(cwd) { return process.platform === 'win32' ? (path.isAbsolute(cwd) ? path.resolve(cwd) : cwd).toLowerCase() : cwd; }
function draftKey(cwd) { return 'dshPanel.draft.v1.' + require('node:crypto').createHash('sha256').update(workspaceIdentity(cwd)).digest('hex'); }
function draftContent(value, trusted) {
  if (!value || typeof value.text !== 'string' || value.text.length > 128 * 1024 || /\0/.test(value.text)) return undefined;
  if (trusted && Array.isArray(value.attachments) && value.attachments.length > 20) return undefined;
  let imageCount = 0, imageBytes = 0;
  const attachments = [];
  if (trusted && Array.isArray(value.attachments)) for (const item of value.attachments) {
    if (item?.kind === 'image') {
      let image;
      try { image = validateImageDescriptor(item); } catch { return undefined; }
      imageCount++; imageBytes += image.byteLength;
      if (imageCount > MAX_IMAGE_COUNT || imageBytes > MAX_MESSAGE_IMAGE_BYTES) return undefined;
      attachments.push(image);
    } else if (item && ['file', 'selection', 'content', 'review', 'skill'].includes(item.kind) &&
      (item.kind === 'file' ? typeof item.uri === 'string' && item.uri.startsWith('file:') : typeof item.text === 'string' && !/\0/.test(item.text)) && typeof item.name === 'string') {
      attachments.push({ ...attachmentMetadata(item), ...Object.fromEntries(['uri', 'text', 'mimeType'].filter(key => typeof item[key] === 'string').map(key => [key, item[key]])), ...(typeof item.text === 'string' ? { byteLength: Buffer.byteLength(item.text, 'utf8') } : {}) });
    }
  }
  if (attachments.reduce((sum, item) => sum + Buffer.byteLength(item.text || '', 'utf8'), 0) > 256 * 1024) return undefined;
  return { text: value.text, attachments };
}
/** 草稿仅保留在本机工作区状态；附件保持发送时的文本快照。 */
function normalizeDraft(value, { cwd, trusted = true, now = Date.now() } = {}) {
  if (!value || value.version !== 1 || typeof cwd !== 'string' || typeof value.cwd !== 'string' || workspaceIdentity(value.cwd) !== workspaceIdentity(cwd) || !Number.isFinite(value.savedAt) || now - value.savedAt > TTL || value.savedAt > now + 60000) return undefined;
  const current = draftContent(value, trusted); if (!current) return undefined;
  const result = { version: 1, cwd, savedAt: value.savedAt, ...current };
  if (value.recoveries !== undefined) {
    if (!Array.isArray(value.recoveries)) return undefined;
    const entries = value.recovery ? [...value.recoveries, value.recovery] : value.recoveries, seen = new Set();
    result.recoveries = [];
    for (const entry of entries) {
      const content = draftContent(entry, trusted); if (!content) return undefined;
      const key = JSON.stringify(content);
      if (!seen.has(key)) { seen.add(key); result.recoveries.push(content); }
    }
  } else if (value.recovery) {
    result.recovery = draftContent(value.recovery, trusted); if (!result.recovery) return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) return undefined;
  return result;
}
module.exports = { normalizeDraft, draftKey, MAX_BYTES, TTL };
