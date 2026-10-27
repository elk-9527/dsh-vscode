/* Caption markers used by dsh-meme. The host owns image access and validation. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DshMemes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function captionKey(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  /** Ambiguous captions stay as text rather than choosing an unrelated image. */
  function createCatalog(values) {
    const items = [], ids = new Set(), captions = new Map();
    function add(key, item) {
      key = captionKey(key);
      if (!key) return;
      if (!captions.has(key)) captions.set(key, item);
      else if (captions.get(key)?.id !== item.id) captions.set(key, null);
    }
    for (const value of Array.isArray(values) ? values.slice(0, 20000) : []) {
      if (!value || typeof value.id !== 'string' || !value.id.startsWith('/dsh-memes/') || value.id.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(value.id) || ids.has(value.id)) continue;
      const item = { id: value.id };
      for (const key of ['caption', 'name', 'keywords', 'tag']) item[key] = typeof value[key] === 'string' ? value[key].slice(0, key === 'keywords' ? 2048 : 512) : '';
      if (!item.caption && !item.name) continue;
      ids.add(item.id); items.push(item);
      for (const key of [item.caption, item.caption.slice(0, 80), item.caption.slice(0, 100), item.name, item.keywords]) add(key, item);
    }
    return { items, find: description => captions.get(captionKey(description)) || undefined };
  }

  /** Locate complete markers, excluding backtick code spans and fenced blocks. */
  function markers(value) {
    const text = String(value || ''), out = [];
    const pattern = /(`+)|\[表情[:：]\s*([^\]\r\n]{1,512})\](?:\(https?:\/\/[^\s)]+\))?/g;
    let codeLength = 0, match;
    while ((match = pattern.exec(text))) {
      if (match[1]) {
        if (!codeLength) codeLength = match[1].length;
        else if (codeLength === match[1].length) codeLength = 0;
      } else if (!codeLength && match[2].trim()) out.push({ index: match.index, raw: match[0], caption: match[2].trim() });
    }
    return out;
  }

  function safeDataUrl(value) {
    return typeof value === 'string' && value.length <= 12 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z\d+/]+={0,2}$/.test(value);
  }

  return { captionKey, createCatalog, markers, safeDataUrl };
});
