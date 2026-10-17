'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const REPOSITORY = 'https://github.com/elk-9527/dsh-vscode';
const CONTENT = `${REPOSITORY}/blob/main/packages/vscode-extension/`;
const IMAGES = 'https://raw.githubusercontent.com/elk-9527/dsh-vscode/main/packages/vscode-extension/';
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
function checkArchiveReadme(file) {
  const literal = "'" + path.resolve(file).replace(/'/g, "''") + "'";
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${literal}); ` +
    `try { $e=$z.Entries | Where-Object FullName -Match '(?i)^extension/readme\\.md$' | Select-Object -First 1; ` +
    `if(-not $e -or $e.Length -gt 1048576){throw 'Invalid package README'}; $r=[IO.StreamReader]::new($e.Open()); ` +
    `try {$r.ReadToEnd()} finally {$r.Dispose()} } finally {$z.Dispose()}`;
  const markdown = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  if (invalidSourceLinks(markdown).length) throw new Error('安装包 README 的源码链接须使用 main 和实际存在的项目路径');
  return true;
}
module.exports = { CONTENT, IMAGES, invalidSourceLinks, checkArchiveReadme };
