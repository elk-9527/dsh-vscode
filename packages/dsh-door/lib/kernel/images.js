/** Exact-model image admission diagnostics over the existing native ACP wire. */
import { randomUUID, createHash } from 'node:crypto';
export const IMAGE_CAPABILITIES_METHOD = 'dsh-door/images/capabilities';
export const IMAGE_READ_METHOD = 'dsh-door/images/read';
const NATIVE_IMAGE_RUNTIMES = new Set(['0.2.1-rc.3']);
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };

export function rememberImageProtocolRequest(frame, state) {
  if (frame?.method === 'initialize' && frame.id !== undefined) state.imageInitializeId = frame.id;
}

/** Initialization gates native ACP admission for the lifetime of this connection. */
export function rememberImageProtocolResponse(frame, state) {
  if (state.imageInitializeId === undefined || frame?.id !== state.imageInitializeId || frame.method !== undefined) return;
  state.imageInitializeId = undefined;
  state.imagePromptEnabled = frame.error === undefined && frame.result?.agentCapabilities?.promptCapabilities?.image === true;
}

function limitsOf(attachments) {
  const limits = attachments?.imageLimits;
  if (!limits || !Array.isArray(limits.mediaTypes)) return undefined;
  const mediaTypes = MEDIA_TYPES.filter(type => limits.mediaTypes.includes(type));
  const names = ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes'];
  if (!mediaTypes.length || names.some(name => !Number.isSafeInteger(limits[name]) || limits[name] < 1)) return undefined;
  return { ...Object.fromEntries(names.map(name => [name, limits[name]])), mediaTypes };
}

/** Only enumerate the tools that this exact Agent scope can see. */
function imageTools(agent) {
  try {
    const registry = agent.ctx.get('tools');
    if (typeof registry?.schemas !== 'function') return undefined;
    const schemas = registry.schemas(agent);
    if (!Array.isArray(schemas) || schemas.length > 2048) return undefined;
    const names = schemas.map(schema => schema?.name).filter(name => typeof name === 'string' && name.length <= 256);
    const image = '(?:image|picture|photo|meme|图片|表情)';
    const search = new RegExp(`(?:search|find|搜).*${image}|${image}.*(?:search|find|搜)`, 'i');
    const generate = new RegExp(`(?:generat|creat|draw|生成|绘).*${image}|${image}.*(?:generat|creat|draw|生成|绘)`, 'i');
    return { meme: names.includes('send_meme'), search: names.filter(name => search.test(name)), generate: names.filter(name => generate.test(name)), evidence: 'registered-tool-names' };
  } catch { return undefined; }
}

export async function resolveImageCapabilities(state, sessionId, { signal } = {}) {
  const agent = state.agentsBySession?.get(sessionId);
  if (!state.sessions?.has(sessionId) || !agent) fail('会话不属于当前连接', -32003);
  const route = state.textModels?.get(sessionId);
  const tools = imageTools(agent);
  const base = { ...(route ? { provider: route.provider, model: route.model } : {}), ...(tools ? { tools } : {}) };
  const unsupported = (reason, extra = {}) => ({ ...base, ...extra, input: false, mode: 'unsupported', reason });
  if (!route) return unsupported('model-route-unresolved');
  if (!NATIVE_IMAGE_RUNTIMES.has(state.imageRuntimeVersion)) return unsupported('acp-image-unsupported');
  const attachments = state.imageAttachments;
  const limits = limitsOf(attachments);
  if (!limits || typeof attachments.saveImages !== 'function' || typeof attachments.readImage !== 'function') return unsupported('attachment-service-unavailable');
  if (typeof state.textLlm?.resolveModelInfo !== 'function') return unsupported('model-capability-unavailable');
  signal?.throwIfAborted();
  let info;
  try { info = await state.textLlm.resolveModelInfo(route.provider, route.model, signal); }
  catch {
    signal?.throwIfAborted();
    return unsupported('model-capability-unavailable', { limits });
  }
  signal?.throwIfAborted();
  if (!state.sessions.has(sessionId) || state.agentsBySession.get(sessionId) !== agent) fail('会话已关闭或更换', -32003);
  const current = state.textModels.get(sessionId);
  if (current?.provider !== route.provider || current?.model !== route.model) fail('模型已变化，请重新检查图片能力', -32042);
  const inputModalities = Array.isArray(info?.inputModalities) ? info.inputModalities.filter(type => typeof type === 'string' && type.length <= 32).slice(0, 16) : [];
  if (!inputModalities.includes('image')) return unsupported('model-does-not-declare-image', { inputModalities, limits });
  if (state.imagePromptEnabled !== true) return unsupported('connection-image-disabled', { inputModalities, limits });
  return { ...base, input: true, mode: 'native', inputModalities, limits };
}

export function closeImageCapabilityRequests(state) {
  state.imageQueriesClosed = true;
  for (const controller of state.imageQueries?.values() || []) controller.abort();
  for (const controller of state.imageReads?.values() || []) controller.abort();
  state.historyImageTokens?.clear();
}

function historyImageRef(value) {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value.attachmentId || '') || !MEDIA_TYPES.includes(value.mediaType) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192) return undefined;
  return Object.freeze(Object.fromEntries(['attachmentId', 'mediaType', 'bytes', 'width', 'height'].map(key => [key, value[key]])));
}

function rasterSignature(data, mediaType) {
  const bytes = Buffer.from(data);
  if (mediaType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mediaType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return mediaType === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Called only after the existing history/get handler has authorized and read it. */
export function projectHistoryImages(result, state) {
  if (!Array.isArray(result?.entries)) return result;
  const tokens = state.historyImageTokens ||= new Map();
  return { ...result, entries: result.entries.map(entry => {
    if (!Array.isArray(entry?.images)) return entry;
    const { images: original, ...copy } = entry;
    const images = [];
    let bytes = 0, omitted = false;
    for (const image of original) {
      const ref = historyImageRef(image?.attachment);
      if (!ref || typeof state.imageAttachments?.readImage !== 'function' || state.imageQueriesClosed || tokens.size >= 1024 || images.length >= 4 || bytes + ref.bytes > 16 * 1024 * 1024) { omitted = true; continue; }
      const id = randomUUID(); tokens.set(id, ref); bytes += ref.bytes;
      images.push({ id, source: `dsh-image:${id}`, alt: '图片' });
    }
    if (omitted) {
      const field = copy.kind === 'tool' ? 'output' : 'text';
      copy[field] = [copy[field], '[图片未载入：当前内核不可读取或超过历史图片回放限制]'].filter(Boolean).join('\n');
    }
    return { ...copy, ...(images.length ? { images } : {}) };
  }) };
}

async function readHistoryImage(state, token, signal) {
  if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) fail('历史图片标识无效', -32602);
  const ref = state.historyImageTokens?.get(token);
  if (!ref || state.imageQueriesClosed) fail('历史图片不属于当前连接，请重新打开对应历史会话', -32003);
  const attachments = state.imageAttachments;
  if (typeof attachments?.readImage !== 'function') fail('当前内核不支持历史图片读取', -32042);
  signal.throwIfAborted();
  let stored;
  try { stored = await attachments.readImage(ref, signal); }
  catch { signal.throwIfAborted(); fail('历史图片已丢失、损坏或无法读取', -32042); }
  signal.throwIfAborted();
  if (state.imageQueriesClosed || state.historyImageTokens?.get(token) !== ref) fail('历史图片读取范围已变化', -32003);
  const data = stored?.data;
  if (!(data instanceof Uint8Array) || data.byteLength > 8 * 1024 * 1024 || data.byteLength !== ref.bytes || stored.ref?.mediaType !== ref.mediaType ||
    stored.ref?.attachmentId !== ref.attachmentId || stored.ref?.width !== ref.width || stored.ref?.height !== ref.height ||
    `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId || !rasterSignature(data, ref.mediaType)) fail('历史图片校验失败或超过大小限制', -32042);
  return { data: Buffer.from(data).toString('base64'), mimeType: ref.mediaType };
}

/** Opaque tokens refer only to image refs from a successful history/get result. */
export function handleHistoryImageRead(frame, state) {
  const cancelId = frame?.method === '$/cancel_request' ? frame.params?.requestId : frame?.method === '$/cancelRequest' ? frame.params?.id : undefined;
  if (cancelId !== undefined && state.imageReads?.has(cancelId)) { state.imageReads.get(cancelId).abort(); return true; }
  if (frame?.method !== IMAGE_READ_METHOD || frame.id === undefined) return false;
  const pending = state.imageReads ||= new Map();
  const reply = value => { if (!state.imageQueriesClosed) return state.respond({ jsonrpc: '2.0', id: frame.id, ...value }); };
  if (pending.size >= 4 || pending.has(frame.id)) { void Promise.resolve(reply({ error: { code: -32045, message: '历史图片读取较多，请稍后重试' } })).catch(() => {}); return true; }
  const controller = new AbortController(); pending.set(frame.id, controller);
  const timer = setTimeout(() => controller.abort(), 10000);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('历史图片读取已取消或超时'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  void Promise.race([aborted, readHistoryImage(state, frame.params?.token, controller.signal)])
    .then(result => { controller.signal.throwIfAborted(); return { result }; })
    .catch(error => ({ error: { code: controller.signal.aborted ? -32800 : error?.code || -32042, message: controller.signal.aborted ? '历史图片读取已取消或超时' : error?.message || '历史图片读取失败' } }))
    .then(reply).catch(() => {})
    .finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); if (pending.get(frame.id) === controller) pending.delete(frame.id); });
  return true;
}

/** Queries have no Agent prompt, no tool invocation, and no model completion. */
export function handleImageCapabilities(frame, state) {
  const cancelId = frame?.method === '$/cancel_request' ? frame.params?.requestId : frame?.method === '$/cancelRequest' ? frame.params?.id : undefined;
  if (cancelId !== undefined && state.imageQueries?.has(cancelId)) { state.imageQueries.get(cancelId).abort(); return true; }
  if (frame?.method !== IMAGE_CAPABILITIES_METHOD || frame.id === undefined) return false;
  const pending = state.imageQueries ||= new Map();
  const reply = value => { if (!state.imageQueriesClosed) return state.respond({ jsonrpc: '2.0', id: frame.id, ...value }); };
  if (pending.size >= 4 || pending.has(frame.id)) { void Promise.resolve(reply({ error: { code: -32045, message: '图片能力查询较多，请稍后重试' } })).catch(() => {}); return true; }
  const controller = new AbortController(); pending.set(frame.id, controller);
  const timer = setTimeout(() => controller.abort(), 10000);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('图片能力查询已取消或超时'), { code: -32800 }));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  void Promise.race([aborted, resolveImageCapabilities(state, frame.params?.sessionId, { signal: controller.signal })])
    .then(result => { controller.signal.throwIfAborted(); return { result }; })
    .catch(error => ({ error: { code: controller.signal.aborted ? -32800 : error?.code || -32042, message: controller.signal.aborted ? '图片能力查询已取消或超时' : error?.message || '图片能力查询失败' } }))
    .then(reply).catch(() => {})
    .finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); if (pending.get(frame.id) === controller) pending.delete(frame.id); });
  return true;
}
