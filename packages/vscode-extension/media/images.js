/* Ordinary image metadata and bounded preview state. Image bytes stay out of drafts. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DshImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_MESSAGE_BYTES = 16 * 1024 * 1024, MAX_IMAGES = 4;
  const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  function mimeType(type, name = '') {
    type = String(type || '').toLowerCase();
    if (type === 'image/jpg') type = 'image/jpeg';
    if (MIME_TYPES.has(type)) return type;
    if (type && type !== 'application/octet-stream') return undefined;
    const ext = String(name).split('.').pop().toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext];
  }
  function descriptor(value) {
    if (!value || value.kind !== 'image' || typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.sha256) || value.id !== `image:${value.sha256}` ||
      !MIME_TYPES.has(value.mimeType) || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > MAX_IMAGE_BYTES || typeof value.name !== 'string') return undefined;
    return { kind: 'image', id: value.id, sha256: value.sha256, name: value.name.slice(0, 512).replace(/[\u0000-\u001f\u007f]/g, ''), mimeType: value.mimeType, byteLength: value.byteLength };
  }
  function attachmentsError(items) {
    if (!Array.isArray(items) || items.length > 20) return '最多附加 20 项，现有内容已保留。';
    const images = items.filter(item => item?.kind === 'image');
    if (images.some(item => !descriptor(item))) return '图片引用无效，请移除后重新添加。';
    if (images.length > MAX_IMAGES || images.reduce((sum, item) => sum + item.byteLength, 0) > MAX_MESSAGE_BYTES) return '每条消息最多 4 张图片、图片合计不超过 16 MiB；现有内容已保留。';
    if (items.reduce((sum, item) => sum + new TextEncoder().encode(item?.text || '').length, 0) > 256 * 1024) return '附件正文总量不超过 256 KiB；现有内容已保留。';
    return undefined;
  }
  function safeDataUrl(value) {
    return typeof value === 'string' && value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z\d+/]+={0,2}$/.test(value);
  }
  function base64(value) {
    return safeDataUrl(value) ? value.slice(value.indexOf(',') + 1) : undefined;
  }
  function createPreviewCache(limit = 48 * 1024 * 1024, count = 64) {
    const entries = new Map(); let bytes = 0;
    return {
      get(key) { const value = entries.get(key); if (value) { entries.delete(key); entries.set(key, value); } return value; },
      put(key, value) {
        if (!safeDataUrl(value)) return [];
        if (entries.has(key)) bytes -= entries.get(key).length;
        entries.delete(key); entries.set(key, value); bytes += value.length;
        const evicted = [];
        while (entries.size > count || bytes > limit) { const next = entries.keys().next().value; bytes -= entries.get(next).length; entries.delete(next); evicted.push(next); }
        return evicted;
      },
      clear() { entries.clear(); bytes = 0; },
      get byteLength() { return bytes; },
      get size() { return entries.size; },
    };
  }
  return { MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_IMAGES, mimeType, descriptor, attachmentsError, safeDataUrl, base64, createPreviewCache };
});
