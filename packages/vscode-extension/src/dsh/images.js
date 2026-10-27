'use strict';
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const IMAGE_TTL = 7 * 86400000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^[a-f0-9]{64}\.image$/;
/** @type {Map<string, Promise<unknown>>} */
const writes = new Map();

/** @typedef {{kind: 'image', id: string, sha256: string, name: string, mimeType: string, byteLength: number}} ImageDescriptor */
/** @typedef {{data: string, mimeType: string, byteLength: number, sha256: string}} ImagePayload */

/** @param {string} message @param {string} [code] @returns {Error & {code: string}} */
function imageError(message, code = 'IMAGE_INVALID') { return Object.assign(new Error(message), { code }); }
/** @param {unknown} value */
function imageName(value) {
  return (typeof value === 'string' ? value.split(/[\\/]/).at(-1) || '' : '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256).trim() || '图片';
}

/** Validate pixels before accepting or displaying any content. SVG is excluded.
 * @param {{data?: unknown, bytes?: Buffer, mimeType?: unknown, name?: unknown}} value
 * @returns {ImagePayload}
 */
function validateImage(value) {
  if (!value || typeof value.mimeType !== 'string' || !IMAGE_TYPES.has(value.mimeType)) throw imageError('仅支持 PNG、JPEG、GIF 和 WebP 图片。');
  let bytes;
  if (value.bytes !== undefined) {
    if (!Buffer.isBuffer(value.bytes)) throw imageError('图片内容无效。');
    bytes = value.bytes;
  } else {
    const data = value.data;
    if (typeof data !== 'string' || !data || data.length % 4 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw imageError('图片编码无效或超过 8 MiB。');
    bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw imageError('图片编码不是规范的 Base64。');
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw imageError('单张图片不超过 8 MiB。', 'IMAGE_LIMIT');
  const starts = (/** @type {number[]} */ values) => values.every((byte, index) => bytes[index] === byte);
  const valid = value.mimeType === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10]) :
    value.mimeType === 'image/jpeg' ? starts([255, 216, 255]) :
    value.mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) :
    bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw imageError('图片内容与声明的格式不符。');
  return { data: bytes.toString('base64'), mimeType: value.mimeType, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Strip every non-metadata field, including pixels and caller-supplied paths.
 * @param {unknown} value @returns {ImageDescriptor}
 */
function validateImageDescriptor(value) {
  if (!value || typeof value !== 'object') throw imageError('图片快照信息无效，请重新添加。');
  const item = /** @type {Record<string, unknown>} */ (value);
  if (item.kind !== 'image' || typeof item.sha256 !== 'string' || !HASH.test(item.sha256) || item.id !== `image:${item.sha256}` ||
      typeof item.mimeType !== 'string' || !IMAGE_TYPES.has(item.mimeType) || typeof item.byteLength !== 'number' || !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 1 || item.byteLength > MAX_IMAGE_BYTES || typeof item.name !== 'string') throw imageError('图片快照信息无效，请重新添加。');
  return { kind: 'image', id: item.id, sha256: item.sha256, name: imageName(item.name), mimeType: item.mimeType, byteLength: item.byteLength };
}

/** @param {unknown} item @returns {{type: 'image', data: string, mimeType: string}} */
function imageContentBlock(item) {
  if (!item || typeof item !== 'object') throw imageError('图片内容缺失，请重新添加。');
  const input = /** @type {Record<string, unknown>} */ (item);
  const payload = validateImage({ data: input.data, mimeType: input.mimeType });
  if (input.id !== undefined || input.sha256 !== undefined || input.byteLength !== undefined) {
    const descriptor = validateImageDescriptor(input);
    if (descriptor.sha256 !== payload.sha256 || descriptor.byteLength !== payload.byteLength || descriptor.mimeType !== payload.mimeType) throw imageError('图片快照已变化，请重新添加。');
  }
  return { type: 'image', data: payload.data, mimeType: payload.mimeType };
}

/** @param {string} value */
const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
/** @param {string} root */
async function assertDirectoryChain(root) {
  const parsed = path.parse(root);
  let current = parsed.root;
  for (const segment of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw imageError('图片缓存目录不允许使用链接或重定向。', 'IMAGE_STORE_UNSAFE');
  }
}

/** @template T @param {string} key @param {() => Promise<T>} action @returns {Promise<T>} */
function exclusive(key, action) {
  const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(action);
  writes.set(key, pending);
  return pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); });
}

/** Immutable, content-addressed image snapshots in VS Code's workspace storage. */
class ImageStore {
  /** @param {{root: string, maxBytes?: number, now?: () => number}} options */
  constructor({ root, maxBytes = MAX_STORE_BYTES, now = Date.now }) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw imageError('图片缓存位置不可用。', 'IMAGE_STORE_UNAVAILABLE');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STORE_BYTES) throw imageError('图片缓存容量无效。');
    this.root = path.resolve(root); this.maxBytes = maxBytes; this.now = now;
  }

  async ensureRoot() {
    await assertDirectoryChain(this.root);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectoryChain(this.root);
    const real = await fs.realpath(this.root);
    if (identity(real) !== identity(this.root)) throw imageError('图片缓存目录已变化。', 'IMAGE_STORE_UNSAFE');
    return real;
  }

  /** @param {ImageDescriptor} item @returns {Promise<Buffer>} */
  async readBytes(item) {
    const root = await this.ensureRoot(), file = path.join(root, item.sha256 + '.image');
    let before;
    try { before = await fs.lstat(file, { bigint: true }); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') throw imageError('图片快照已失效，请移除后重新添加。', 'IMAGE_MISSING');
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > MAX_IMAGE_BYTES || before.size !== BigInt(item.byteLength)) throw imageError('图片快照身份或大小已变化。', 'IMAGE_STORE_UNSAFE');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1n) throw imageError('图片快照身份已变化。', 'IMAGE_STORE_UNSAFE');
      bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw imageError('图片快照读取不完整。');
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw imageError('图片快照在读取时发生变化。');
    } finally { await handle.close(); }
    const final = await fs.lstat(file, { bigint: true });
    if (final.isSymbolicLink() || final.ino !== before.ino || final.dev !== before.dev || final.size !== before.size || identity(await fs.realpath(file)) !== identity(file) || identity(await fs.realpath(this.root)) !== identity(root)) throw imageError('图片快照位置已变化。', 'IMAGE_STORE_UNSAFE');
    return bytes;
  }

  /** @param {ImageDescriptor | unknown} value @returns {Promise<ImagePayload>} */
  async read(value) {
    const item = validateImageDescriptor(value);
    const payload = validateImage({ bytes: await this.readBytes(item), mimeType: item.mimeType });
    if (payload.sha256 !== item.sha256 || payload.byteLength !== item.byteLength) throw imageError('图片快照校验失败，请重新添加。', 'IMAGE_INTEGRITY');
    return payload;
  }

  /** @param {{data?: unknown, bytes?: Buffer, mimeType?: unknown, name?: unknown}} value @returns {Promise<ImageDescriptor>} */
  async put(value) {
    const payload = validateImage(value);
    const item = validateImageDescriptor({ kind: 'image', id: `image:${payload.sha256}`, sha256: payload.sha256, mimeType: payload.mimeType, byteLength: payload.byteLength, name: imageName(value.name) });
    return exclusive(identity(this.root), async () => {
      const root = await this.ensureRoot();
      try { await this.read(item); return item; } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'IMAGE_MISSING') throw error; }
      let used = 0;
      for (const name of await fs.readdir(root)) {
        const stat = await fs.lstat(path.join(root, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw imageError('图片缓存包含不安全的条目。', 'IMAGE_STORE_UNSAFE');
        used += stat.size;
        if (used > this.maxBytes) break;
      }
      if (used + payload.byteLength > this.maxBytes) throw imageError('图片缓存已达到容量上限，请先清理不再使用的图片快照。', 'IMAGE_STORE_LIMIT');
      const target = path.join(root, item.sha256 + '.image');
      const temporary = path.join(root, `.${item.sha256}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, Buffer.from(payload.data, 'base64'), { flag: 'wx', mode: 0o600 });
        if (identity(await fs.realpath(this.root)) !== identity(root)) throw imageError('图片缓存目录已变化。', 'IMAGE_STORE_UNSAFE');
        await fs.rename(temporary, target);
        await this.read(item);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return item;
    });
  }

  /** Only explicitly unreferenced, expired image files are removed; no recursive cleanup.
   * @param {{protectedIds: Iterable<string>, ttlMs?: number}} options
   */
  async prune({ protectedIds, ttlMs = IMAGE_TTL }) {
    if (!protectedIds || !Number.isFinite(ttlMs) || ttlMs < IMAGE_TTL) throw imageError('图片缓存清理条件无效。');
    const retained = new Set(protectedIds);
    return exclusive(identity(this.root), async () => {
      const root = await this.ensureRoot();
      let removed = 0;
      for (const name of await fs.readdir(root)) {
        if (!FILE.test(name) || retained.has(`image:${name.slice(0, 64)}`)) continue;
        const file = path.join(root, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || this.now() - stat.mtimeMs <= ttlMs) continue;
        if (path.dirname(file) !== root || identity(await fs.realpath(file)) !== identity(file) || identity(await fs.realpath(this.root)) !== identity(root)) throw imageError('图片缓存目录已变化。', 'IMAGE_STORE_UNSAFE');
        await fs.unlink(file); removed++;
      }
      return removed;
    });
  }
}

module.exports = { ImageStore, validateImage, validateImageDescriptor, imageContentBlock, imageName,
  MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_MESSAGE_IMAGE_BYTES, MAX_STORE_BYTES, IMAGE_TTL };
