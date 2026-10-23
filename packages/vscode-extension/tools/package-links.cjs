'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { shipFiles } = require('./ship-list');
const REPOSITORY = 'https://github.com/elk-9527/dsh-vscode';
const CONTENT = `${REPOSITORY}/blob/main/packages/vscode-extension/`;
const IMAGES = 'https://raw.githubusercontent.com/elk-9527/dsh-vscode/main/packages/vscode-extension/';
const normalize = bytes => bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
function renderedReadme(text) {
  return text.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (whole, before, target, after) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return whole;
    return before + new URL(target, before.startsWith('!') ? IMAGES : CONTENT).href + after;
  });
}
function verifyPackageFiles(source, destination, { installed = false } = {}) {
  const expected = new Set(shipFiles(source)), found = new Map();
  const aliases = { 'license.txt': 'LICENSE', 'readme.md': 'README.md', 'changelog.md': 'CHANGELOG.md' };
  const walk = relative => {
    const file = path.join(destination, relative), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'Package contains a link');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) walk(path.join(relative, name)); return; }
    const raw = relative.replace(/\\/g, '/'), name = aliases[raw.toLowerCase()] || raw;
    if (installed && raw === '.vsixmanifest') return;
    assert(expected.has(name) && !found.has(name), `Unexpected package file: ${raw}`);
    found.set(name, file);
  };
  for (const name of fs.readdirSync(destination)) walk(name);
  for (const name of expected) {
    assert(found.has(name), `Missing package file: ${name}`);
    const a = normalize(fs.readFileSync(path.join(source, name))), b = normalize(fs.readFileSync(found.get(name)));
    if (a.equals(b)) continue;
    if (name === 'README.md' && Buffer.from(renderedReadme(a.toString('utf8'))).equals(b)) continue;
    if (name === 'package.json') {
      const original = JSON.parse(a), packaged = JSON.parse(b);
      if (installed) delete packaged.__metadata;
      assert.deepEqual(packaged, original, `Stale package: ${name}`); continue;
    }
    assert.fail(`Stale package: ${name}`);
  }
  return { files: expected.size };
}
function invalidSourceLinks(markdown, root = path.resolve(__dirname, '../../..')) {
  const invalid = [];
  for (const match of markdown.matchAll(/https:\/\/github\.com\/elk-9527\/dsh-vscode\/(?:blob|tree)\/[^\s)"'<>]+/g)) {
    const url = new URL(match[0]);
    const [, , , kind, branch, ...parts] = url.pathname.split('/');
    const relative = decodeURIComponent(parts.join('/'));
    const file = path.resolve(root, relative);
    if (!['blob', 'tree'].includes(kind) || branch !== 'main' || !relative ||
        !file.startsWith(root + path.sep) || !fs.existsSync(file)) invalid.push(match[0]);
  }
  return invalid;
}
function checkArchiveReadme(file, { platform = process.platform, run = execFileSync, python = 'python3' } = {}) {
  const literal = "'" + path.resolve(file).replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${literal}); ` +
    `try { $e=$z.Entries | Where-Object FullName -Match '(?i)^extension/readme\\.md$' | Select-Object -First 1; ` +
    `if(-not $e -or $e.Length -gt 1048576){throw 'Invalid package README'}; $r=[IO.StreamReader]::new($e.Open()); ` +
    `try {$r.ReadToEnd()} finally {$r.Dispose()} } finally {$z.Dispose()}`;
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 };
  const markdown = platform === 'win32' ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options)
    : run(python, ['-c', String.raw`import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = [item for item in archive.infolist() if item.filename.lower() == 'extension/readme.md']
    if len(entries) != 1 or entries[0].file_size > 1048576:
        raise ValueError('Invalid package README')
    content = archive.read(entries[0])
    content.decode('utf-8')
    sys.stdout.buffer.write(content)`, path.resolve(file)], options);
  if (invalidSourceLinks(markdown).length) throw new Error('安装包 README 的源码链接须使用 main 和实际存在的项目路径');
  return true;
}
module.exports = { CONTENT, IMAGES, invalidSourceLinks, checkArchiveReadme, renderedReadme, verifyPackageFiles };
