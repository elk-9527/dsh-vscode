'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { fileURLToPath } = require('node:url');
const { validateImage, MAX_IMAGE_BYTES } = require('../dsh/images');
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 图片。');
}

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && [0,168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19].includes(b));
  }
  if (family !== 6) return false;
  const lower = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // IPv4-mapped, compatible and local IPv6 addresses are not public image hosts.
  return !lower.startsWith('::') && !lower.startsWith('64:ff9b:') && !/^(?:fc|fd|fe[89ab]|ff)/.test(lower);
}

async function resolvePublicUrl(source, { lookup = dns.lookup, signal } = {}) {
  const url = new URL(source);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || source.length > 8192) throw new Error('图片链接无效。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal?.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(new Error('图片链接读取已取消。')); signal?.addEventListener('abort', abort, { once: true }); });
  let values;
  try { values = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await Promise.race([lookup(hostname, { all: true, verbatim: true }), cancelled]); }
  finally { signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
  if (!values.length || values.some(value => !publicAddress(value.address))) throw new Error('图片链接不能访问本机或私有网络。');
  return { url, address: values[0] };
}

async function remoteImage(source, { signal, lookup } = {}, redirects = 0) {
  const { url, address } = await resolvePublicUrl(source, { signal, lookup });
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'DSH-Panel' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, resolve);
    request.on('error', reject); request.end();
  });
  if ([301,302,303,307,308].includes(response.statusCode)) {
    response.resume();
    if (redirects >= 3 || !response.headers.location) throw new Error('图片链接重定向过多。');
    return remoteImage(new URL(response.headers.location, url).href, { signal, lookup }, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error('图片链接读取失败。'); }
  const length = Number(response.headers['content-length']);
  if (length > MAX_IMAGE_BYTES) { response.destroy(); throw new Error('图片超过 8 MiB。'); }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB。');
      chunks.push(chunk);
    }
  } finally { if (!response.complete) response.destroy(); }
  const bytes = Buffer.concat(chunks);
  const mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return validateImage({ bytes, mimeType });
}

async function localImage(source, cwd, { signal, guard = () => {} } = {}) {
  signal?.throwIfAborted(); guard();
  if (typeof source !== 'string' || !source || source.length > 8192 || /[\u0000-\u001f\u007f]/.test(source) || /^[/\\]{2}/.test(source)) throw new Error('工作区图片路径无效。');
  let file;
  if (/^file:/i.test(source)) {
    const url = new URL(source);
    if (url.hostname || url.search || url.hash) throw new Error('工作区图片路径无效。');
    file = fileURLToPath(url);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[/\\]/i.test(source) || /[?#]/.test(source)) throw new Error('工作区图片路径无效。');
    let decoded; try { decoded = decodeURIComponent(source); } catch { throw new Error('工作区图片路径无效。'); }
    if (/\0/.test(decoded) || /^[/\\]{2}/.test(decoded)) throw new Error('工作区图片路径无效。');
    file = path.resolve(cwd, decoded);
  }
  const root = await fs.realpath(cwd), target = await fs.realpath(file);
  if (!within(root, target)) throw new Error('图片不在当前工作区内。');
  const stat = await fs.lstat(target, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n || stat.size > BigInt(MAX_IMAGE_BYTES)) throw new Error('工作区图片不可读取或超过 8 MiB。');
  const handle = await fs.open(target, 'r'); let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile() || opened.nlink > 1n || opened.size > BigInt(MAX_IMAGE_BYTES)) throw new Error('图片文件已变化。');
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; signal?.throwIfAborted(); }
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  if (await fs.realpath(cwd) !== root || await fs.realpath(file) !== target || !within(root, await fs.realpath(target))) throw new Error('图片文件位置已变化。');
  signal?.throwIfAborted(); guard();
  return validateImage({ bytes, mimeType: imageMime(bytes) });
}

async function resolveImage(source, cwd, options = {}) {
  if (typeof source !== 'string') throw new Error('图片链接无效。');
  return /^https?:\/\//i.test(source) ? remoteImage(source, options) : localImage(source, cwd, options);
}

module.exports = { imageMime, publicAddress, resolvePublicUrl, localImage, remoteImage, resolveImage };
