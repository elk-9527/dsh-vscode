/** Read-only adapters for visual content owned by an installed DSH plugin. */
export const MEDIA_PREFIX = 'dsh-door/media/';
export const MEDIA_CAPABILITY = Object.freeze({ protocolVersion: 1, providers: ['dsh-meme'] });
const PROVIDER = 'dsh-meme';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 25000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function localWebHost(webServer) {
  let host = webServer?.host;
  if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';
  if (host === '::' || host === '::1' || host === '[::1]') host = '[::1]';
  return ['127.0.0.1', '[::1]'].includes(host) ? host : undefined;
}

function webOrigin(webServer) {
  const host = localWebHost(webServer);
  const port = Number(webServer?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${host}:${port}`;
}

/** Only catalog-owned image routes can become IDs; never accept URLs or files. */
function imageId(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/dsh-memes/')) return undefined;
  if (/%(?:2f|5c)/i.test(value)) return undefined;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return undefined; }
  if (/[\\?#%\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  const segments = decoded.split('/');
  if (segments.some((segment, index) => index > 0 && (!segment || segment === '.' || segment === '..'))) return undefined;
  return segments.map(segment => encodeURIComponent(segment)).join('/');
}

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
}

function validImage(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return mimeType === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function boundedBody(response, maxBytes) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new Error('表情包内容超过大小限制'); }
  if (!response.body) throw new Error('表情包接口返回了空内容');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('表情包内容超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** Reuses the plugin's HTTP contract instead of reading its private database. */
export function createMemeMediaHandler(webServer, { timeoutMs = 5000, maxBytes = MAX_BYTES, now = Date.now } = {}) {
  if (!localWebHost(webServer)) return undefined;
  const lifetime = new AbortController();
  let allowed = new Set(), loadedAt = -Infinity, loadedOrigin;
  const request = async (route, { signal } = {}) => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    const origin = webOrigin(webServer);
    if (!origin) throw new Error('DSH 图片服务当前不可用');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(origin + route, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('DSH 表情包插件接口不可用'); }
      const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      const bytes = await boundedBody(response, maxBytes);
      controller.signal.throwIfAborted();
      return { bytes, mimeType, origin };
    } catch (error) {
      if (signal?.aborted || lifetime.signal.aborted) throw new Error('表情包读取已取消');
      if (controller.signal.aborted) throw new Error('DSH 表情包接口读取超时');
      // Network errors and response bodies can contain local configuration.
      if (error?.message === '表情包内容超过大小限制') throw error;
      throw new Error('DSH 表情包插件接口不可用');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', abort);
    }
  };
  const catalog = async ({ signal } = {}) => {
    const { bytes, mimeType, origin } = await request('/dsh-memes-api?packId=all', { signal });
    if (mimeType !== 'application/json') throw new Error('DSH 表情包图库格式不受支持');
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('DSH 表情包图库格式不受支持'); }
    if (payload?.ok !== true || !Array.isArray(payload.memes) || payload.memes.length > MAX_ITEMS) throw new Error('DSH 表情包图库格式不受支持');
    const items = [], ids = new Set();
    for (const row of payload.memes) {
      const id = imageId(row?.url);
      if (!id || ids.has(id)) continue;
      const caption = text(row.caption, 4096), name = text(row.file_name, 1024);
      if (!caption && !name) continue;
      ids.add(id);
      items.push({ id, caption, keywords: text(row.keywords, 4096), name, tag: text(row.tag, 128) });
    }
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    allowed = ids; loadedAt = now(); loadedOrigin = origin;
    return { provider: PROVIDER, items };
  };
  return {
    capability: MEDIA_CAPABILITY,
    catalog,
    async read(id, { signal, sourceOrigin } = {}) {
      if (sourceOrigin !== undefined && (typeof sourceOrigin !== 'string' || sourceOrigin !== webOrigin(webServer))) throw new Error('图片链接不属于当前 DSH 服务');
      if (imageId(id) !== id) throw new Error('表情包标识无效');
      if (now() - loadedAt > 30000 || loadedOrigin !== webOrigin(webServer)) await catalog({ signal });
      if (!allowed.has(id)) throw new Error('该图片不在表情包图库中');
      const { bytes, mimeType } = await request(id, { signal });
      if (!IMAGE_TYPES.has(mimeType) || !validImage(bytes, mimeType)) throw new Error('表情包图片格式不受支持');
      return { provider: PROVIDER, id, mimeType, data: bytes.toString('base64') };
    },
    dispose() { lifetime.abort(); allowed.clear(); },
  };
}

export function cancelMediaRequest(frame, state) {
  const id = frame?.method === '$/cancelRequest' ? frame.params?.id : frame?.method === '$/cancel_request' ? frame.params?.requestId : undefined;
  const controller = id !== undefined && state.mediaReads?.get(id);
  if (!controller) return false;
  controller.abort(); return true;
}

export function closeMediaRequests(state) {
  state.mediaClosed = true;
  for (const controller of state.mediaReads?.values() || []) controller.abort();
}

/** Reserve reads synchronously, then complete them independently of ACP turns. */
export function handleMediaRequest(frame, state, diag = () => {}) {
  if (!frame || frame.id === undefined || typeof frame.method !== 'string' || !frame.method.startsWith(MEDIA_PREFIX)) return false;
  const reads = state.mediaReads ||= new Map();
  const reply = value => { if (!state.mediaClosed) state.respond({ jsonrpc: '2.0', id: frame.id, ...value }); };
  const fail = (code, message) => reply({ error: { code, message } });
  const method = frame.method.slice(MEDIA_PREFIX.length), handler = state.mediaHandler;
  if (!['catalog', 'read'].includes(method) || !handler) { fail(-32601, '当前接入点不支持表情包读取'); return true; }
  if (frame.params?.provider !== PROVIDER) { fail(-32602, '表情包提供方无效'); return true; }
  if (reads.has(frame.id)) { fail(-32600, '表情包请求 id 已在使用'); return true; }
  if (reads.size >= 8) { fail(-32000, '表情包读取较多，请稍后重试'); return true; }
  const controller = new AbortController(); reads.set(frame.id, controller);
  void Promise.resolve().then(() => method === 'catalog'
    ? handler.catalog({ signal: controller.signal })
    : handler.read(frame.params?.id, { signal: controller.signal, sourceOrigin: frame.params?.sourceOrigin }))
    .then(result => { controller.signal.throwIfAborted(); return { result }; })
    .catch(error => ({ error: { code: controller.signal.aborted ? -32800 : -32000, message: controller.signal.aborted ? '表情包读取已取消' : error?.message || '表情包读取失败' } }))
    .then(reply)
    .catch(() => { diag('表情包应答连接已关闭'); })
    .finally(() => { if (reads.get(frame.id) === controller) reads.delete(frame.id); });
  return true;
}
