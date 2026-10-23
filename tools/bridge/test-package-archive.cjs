'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const tar = require('tar');
const { extractPackageArchive } = require('./package-archive.cjs');
const parent = path.resolve(__dirname, '../../build');
fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'package-archive-test-'));
try {
  const source = path.join(folder, 'source with spaces');
  const unicode = 'package/docs/中文目录/' + '长文件名'.repeat(15) + '.md';
  const expected = new Map([
    ['package/package.json', Buffer.from('{"name":"archive-fixture","version":"1.0.0"}\n')],
    [unicode, Buffer.from('中文内容\r\nUTF-8 bytes remain unchanged.\n')],
    ['package/assets/binary.dat', Buffer.from([0, 255, 128, 13, 10])],
  ]);
  for (const [name, bytes] of expected) {
    const file = path.join(source, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const normal = path.join(folder, 'upstream with spaces.tgz');
  tar.c({ cwd: source, file: normal, gzip: true, sync: true, portable: true }, ['package']);
  const destination = path.join(folder, '解包 with spaces'); fs.mkdirSync(destination);
  const entries = extractPackageArchive(normal, destination);
  assert.equal(entries.filter(entry => entry.type !== 'Directory').length, expected.size);
  for (const [name, bytes] of expected) assert.deepEqual(fs.readFileSync(path.join(destination, ...name.split('/'))), bytes);

  // Construct invalid headers without relying on paths available on the host OS.
  function archive(name, records, truncated = false) {
    const blocks = [];
    for (const record of records) {
      const body = Buffer.from(record.body || 'fixture');
      const header = new tar.Header({ path: record.path, type: record.type || 'File', mode: 0o644,
        size: record.size ?? (record.type ? 0 : body.length), linkpath: record.linkpath || '', mtime: new Date(0) });
      header.encode(); blocks.push(header.block);
      if (!record.type && !truncated) blocks.push(body, Buffer.alloc((512 - body.length % 512) % 512));
    }
    if (!truncated) blocks.push(Buffer.alloc(1024));
    const file = path.join(folder, name + '.tgz'); fs.writeFileSync(file, gzipSync(Buffer.concat(blocks))); return file;
  }
  const cases = [
    ['parent', [{ path: 'package/../outside.txt' }]],
    ['absolute', [{ path: '/package/outside.txt' }]],
    ['drive', [{ path: 'C:/package/outside.txt' }]],
    ['backslash-parent', [{ path: 'package/dir\\..\\..\\outside.txt' }]],
    ['outside-root', [{ path: 'other/file.txt' }]],
    ['duplicate', [{ path: 'package/file.txt' }, { path: 'package/file.txt' }]],
    ['case-collision', [{ path: 'package/FILE.txt' }, { path: 'package/file.txt' }]],
    ['symlink', [{ path: 'package/link', type: 'SymbolicLink', linkpath: '../outside' }]],
    ['hardlink', [{ path: 'package/link', type: 'Link', linkpath: 'package/file' }]],
    ['special', [{ path: 'package/pipe', type: 'FIFO' }]],
    ['oversized', [{ path: 'package/large', size: 64 * 1024 * 1024 + 1 }], true],
    ['truncated', [{ path: 'package/truncated', size: 4096 }], true],
    ['empty', []],
  ];
  for (const [name, records, truncated] of cases) {
    const output = path.join(folder, name); fs.mkdirSync(output);
    assert.throws(() => extractPackageArchive(archive(name, records, truncated), output), undefined, name);
    assert.deepEqual(fs.readdirSync(output), [], name + ' must fail before extracting any file');
  }
  assert.throws(() => extractPackageArchive(normal, destination), /empty directory/);
  assert(!fs.existsSync(path.join(folder, 'outside.txt')));
  console.log(`PASS UTF-8/PAX paths, spaces and binary content; ${cases.length} invalid archives rejected before extraction`);
} finally {
  assert.equal(path.dirname(path.resolve(folder)), parent);
  assert(!fs.lstatSync(folder).isSymbolicLink());
  fs.rmSync(folder, { recursive: true, force: true });
}
