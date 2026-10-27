'use strict';

const PROVIDER = 'dsh-meme';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A catalog route is an opaque identifier, never a filesystem path or URL. */
function validMemeId(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/dsh-memes/')) return false;
  try {
    const decoded = decodeURIComponent(value);
    return !/[\\\u0000-\u001f\u007f?#]/.test(decoded) && !decoded.split('/').some(part => part === '.' || part === '..') &&
      new URL(value, 'http://127.0.0.1').pathname === value;
  } catch { return false; }
}

function catalogItems(value) {
  if (value?.provider !== PROVIDER || !Array.isArray(value.items) || value.items.length > 25000 ||
      Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('表情图库返回了无效内容。');
  const seen = new Set();
  return value.items.map(row => {
    if (!row || !validMemeId(row.id) || seen.has(row.id)) throw new Error('表情图库返回了无效内容。');
    seen.add(row.id);
    const item = { id: row.id };
    for (const key of ['caption', 'name', 'keywords', 'tag']) {
      if (row[key] !== undefined && typeof row[key] !== 'string') throw new Error('表情图库返回了无效内容。');
      item[key] = (row[key] || '').slice(0, key === 'keywords' ? 4096 : 1024);
    }
    return item;
  });
}

function imageDataUrl(value, id) {
  if (value?.provider !== PROVIDER || value.id !== id || !MIME.has(value.mimeType) || typeof value.data !== 'string' ||
      value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('表情图片格式无效。');
  const bytes = Buffer.from(value.data, 'base64');
  const starts = (...values) => values.every((byte, index) => bytes[index] === byte);
  const valid = value.mimeType === 'image/png' ? starts(137, 80, 78, 71, 13, 10, 26, 10) :
    value.mimeType === 'image/jpeg' ? starts(255, 216, 255) :
    value.mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) :
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value.data) throw new Error('表情图片格式无效。');
  return `data:${value.mimeType};base64,${value.data}`;
}

/** Bind media reads to the active connection, view, session and trusted directory. */
class MemeMedia {
  constructor({ scope, post }) {
    this.scope = scope; this.post = post; this.epoch = 0; this.pending = new Set();
    this.items = new Map(); this.cache = new Map(); this.cacheBytes = 0;
  }

  reset() {
    this.epoch++;
    for (const controller of this.pending) controller.abort();
    this.pending.clear(); this.items.clear(); this.cache.clear(); this.cacheBytes = 0;
    this.post({ type: 'memeReset' });
  }

  capture(message) {
    const current = this.scope();
    if (!current.trusted || !current.client?.isConnected || !current.view ||
        message.cwd && message.cwd !== current.cwd || message.sessionId && message.sessionId !== current.sessionId) return undefined;
    return { ...current, epoch: this.epoch };
  }

  current(scope) {
    const current = this.scope();
    return scope.epoch === this.epoch && current.trusted && current.client === scope.client && current.client?.isConnected &&
      current.view === scope.view && current.cwd === scope.cwd && current.sessionId === scope.sessionId;
  }

  async handle(message) {
    const scope = this.capture(message);
    const reply = { requestId: message.requestId, cwd: scope?.cwd, sessionId: scope?.sessionId };
    const type = message.type === 'memeCatalog' ? 'memeCatalog' : 'memeImage';
    const respond = body => { if (scope && this.current(scope)) this.post({ type, ...reply, ...body }); };
    if (!scope) {
      this.post({ type, ...reply, id: message.id, available: false, error: '请连接 DSH 并信任当前工作区后使用表情图库。' });
      return;
    }
    if (scope.status?.capabilities?.media?.protocolVersion !== 1 || !scope.status.capabilities.media.providers?.includes(PROVIDER)) {
      respond({ available: false, id: message.id, items: [], error: '当前接入点未提供表情图库，请更新 dsh-acp-door 并重新连接。' });
      return;
    }
    if (this.pending.size >= 32) { respond({ id: message.id, error: '表情图片正在加载，请稍后重试。' }); return; }
    const controller = new AbortController(); this.pending.add(controller);
    try {
      if (message.type === 'memeCatalog') {
        const result = await scope.client.request('dsh-door/media/catalog', { provider: PROVIDER },
          { signal: controller.signal, timeoutMs: 7000, abortTimeoutMs: 1000 });
        const items = catalogItems(result);
        if (!this.current(scope)) return;
        this.items = new Map(items.map(item => [item.id, item]));
        this.cache.clear(); this.cacheBytes = 0;
        respond({ provider: PROVIDER, items, available: true });
      } else {
        if (!validMemeId(message.id) || !this.items.has(message.id)) throw new Error('请重新打开表情图库后选择图片。');
        let dataUrl = this.cache.get(message.id);
        if (!dataUrl) {
          const result = await scope.client.request('dsh-door/media/read', { provider: PROVIDER, id: message.id },
            { signal: controller.signal, timeoutMs: 7000, abortTimeoutMs: 1000 });
          dataUrl = imageDataUrl(result, message.id);
          if (!this.current(scope) || !this.items.has(message.id)) return;
          this.cache.set(message.id, dataUrl); this.cacheBytes += dataUrl.length;
          while (this.cacheBytes > 16 * 1024 * 1024 || this.cache.size > 32) {
            const key = this.cache.keys().next().value;
            this.cacheBytes -= this.cache.get(key).length; this.cache.delete(key);
          }
        }
        respond({ provider: PROVIDER, id: message.id, dataUrl });
      }
    } catch {
      if (!controller.signal.aborted) respond({ available: false, id: message.id, items: [], error: message.type === 'memeCatalog' ?
        '无法读取表情图库，请确认当前 DSH 已启用 dsh-meme，再打开重试。' : '表情图片加载失败，原消息已保留。' });
    } finally { this.pending.delete(controller); }
  }
}

module.exports = { MemeMedia, catalogItems, imageDataUrl, validMemeId };
