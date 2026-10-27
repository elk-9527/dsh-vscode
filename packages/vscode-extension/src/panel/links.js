'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Resolve only existing relative files inside the active, trusted workspace. */
async function resolveFileLink(href, cwd) {
  if (typeof href !== 'string' || !href || href.length > 8192 || typeof cwd !== 'string' || !cwd) return undefined;
  if (/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(href) || /[\u0000-\u001f\u007f\\]/.test(href)) return undefined;
  const [pathname, fragment = ''] = href.split('#');
  if (!pathname || pathname.includes('?')) return undefined;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (/[:\\\u0000-\u001f\u007f]/.test(decoded) || path.isAbsolute(decoded)) return undefined;
  const root = path.resolve(cwd), file = path.resolve(root, decoded);
  if (!within(root, file)) return undefined;
  try {
    const [realRoot, realFile, stat] = await Promise.all([fs.realpath(root), fs.realpath(file), fs.stat(file)]);
    if (!stat.isFile() || !within(realRoot, realFile)) return undefined;
    const line = /^L([1-9]\d{0,6})(?:-L?[1-9]\d{0,6})?$/.exec(fragment)?.[1];
    return { file: realFile, line: line ? Number(line) - 1 : undefined };
  } catch { return undefined; }
}
module.exports = { resolveFileLink };
