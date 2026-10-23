'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const tar = require('tar');

/** Decode npm tar paths in Node, independently of the host tar and locale. */
function extractPackageArchive(file, destination) {
  assert(fs.statSync(file).size <= 64 * 1024 * 1024, 'Package archive exceeds size budget');
  const target = fs.lstatSync(destination);
  assert(target.isDirectory() && !target.isSymbolicLink() && fs.readdirSync(destination).length === 0,
    'Package extraction requires an empty directory');
  const entries = [], names = new Set();
  let bytes = 0;
  // Validate the entire archive before writing any entry, including link targets.
  tar.t({ file, sync: true, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, ''), parts = name.split('/');
    assert(parts[0] === 'package' && parts.length <= 64 &&
      !/[\\<>:"|?*\u0000-\u001f]/.test(name) &&
      parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe package archive path');
    assert(['File', 'OldFile', 'Directory'].includes(entry.type) &&
      (name !== 'package' || entry.type === 'Directory'), 'Package archive contains a link or special entry');
    const key = name.normalize('NFC').toLowerCase();
    assert(!names.has(key), 'Duplicate package archive path'); names.add(key);
    bytes += entry.size;
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && bytes <= 64 * 1024 * 1024 && entries.length < 10000,
      'Package archive exceeds extraction budget');
    const record = { path: name, type: entry.type, size: entry.size };
    entries.push(record);
    if (entry.type !== 'Directory') {
      const hash = createHash('sha256');
      entry.on('data', chunk => hash.update(chunk));
      entry.on('end', () => { record.sha256 = hash.digest('hex'); });
    }
  } });
  assert(entries.some(entry => entry.sha256), 'Package archive contains no files');
  tar.x({ file, cwd: destination, sync: true, strict: true, preserveOwner: false, noMtime: true, maxDepth: 64 });
  for (const entry of entries) {
    const extracted = path.join(destination, ...entry.path.split('/')), stat = fs.lstatSync(extracted);
    assert(!stat.isSymbolicLink(), 'Extracted package contains a link');
    if (entry.type === 'Directory') assert(stat.isDirectory(), 'Extracted package directory is missing');
    else {
      assert(stat.isFile() && stat.size === entry.size, 'Extracted package file size differs');
      assert.equal(createHash('sha256').update(fs.readFileSync(extracted)).digest('hex'), entry.sha256,
        'Extracted package file content differs');
    }
  }
  return entries;
}
module.exports = { extractPackageArchive };
