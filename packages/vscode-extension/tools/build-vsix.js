'use strict';

/**
 * 将扩展打包为一个 .vsix 文件（供本地安装，不发布至商店）。
 *
 * 自行实现而不使用 @vscode/vsce 的原因：
 * 1. vsix 文件是结构固定的 zip 归档，自行打包可完全控制内容；
 * 2. 无需在本机额外安装 npm 包（减少一处依赖污染与一处潜在故障点）；
 * 3. 调整打包内容时，仅需修改一个数组。
 *
 * vsix 的结构：
 *   extension.vsixmanifest    声明（标识、版本、依赖的 VS Code 版本、资源清单）
 *   [Content_Types].xml       zip 里每种文件扩展名的 MIME 声明
 *   extension/**              扩展本体（package.json 必须在 extension/ 根下）
 *
 * 用法：node tools/build-vsix.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SHIP } = require('./ship-list');
const { renderedReadme, checkArchiveReadme } = require('./package-links.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.resolve(ROOT, '../../build/vscode-extension');

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function copyInto(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyInto(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** zip 中每种扩展名的 Content-Type；缺少任一条目都会导致相应文件无法安装。 */
const CONTENT_TYPES = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.ts': 'text/plain',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.xml': 'text/xml',
  '.vsixmanifest': 'text/xml',
};

function contentTypesXml() {
  const defaults = Object.entries(CONTENT_TYPES)
    .map(([ext, type]) => `  <Default Extension="${ext.slice(1)}" ContentType="${type}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults}
</Types>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function powershellLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function createArchive(stage, file, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') {
    run('python3', ['-c', [
      'import os, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED) as archive:',
      '  for root, directories, files in os.walk(sys.argv[1]):',
      '    directories.sort()',
      '    for name in sorted(files):',
      '      source = os.path.join(root, name)',
      '      archive.write(source, os.path.relpath(source, sys.argv[1]).replace(os.sep, "/"))',
    ].join('\n'), stage, file], { stdio: 'inherit', windowsHide: true, timeout: 60000 });
    return;
  }
  run('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `if (Test-Path -LiteralPath ${powershellLiteral(file)}) { Remove-Item -LiteralPath ${powershellLiteral(file)} }; ` +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${powershellLiteral(stage)}, ${powershellLiteral(file)})`],
  { stdio: 'inherit', windowsHide: true, timeout: 60000 });
}
function archiveEntries(file, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') return JSON.parse(run('python3', ['-c',
    'import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: print(json.dumps(archive.namelist()))', file],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }));
  const check = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead(${powershellLiteral(file)}); ` +
    'try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return check.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function manifestXml(manifest) {
  const categories = Array.isArray(manifest.categories) ? manifest.categories.join(',') : 'Other';
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher)}" />
    <DisplayName>${escapeXml(manifest.displayName || manifest.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(manifest.description || '')}</Description>
    <Tags>ai,harness,dsh</Tags>
    <Categories>${escapeXml(categories)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(manifest.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function main(args = process.argv.slice(2)) {
  const manifest = readManifest();
  const options = require('../../../tools/compat/lib.cjs').argsOf(args);
  if (Object.keys(options).some(key => key !== 'out') || options.out !== undefined && typeof options.out !== 'string') throw new Error('仅支持 --out 指定候选安装包');
  const explicit = typeof options.out === 'string';
  const vsix = explicit ? path.resolve(options.out) : path.join(BUILD, `${manifest.name}-${manifest.version}.vsix`);
  if (!vsix.endsWith('.vsix')) throw new Error('候选安装包必须使用 .vsix 扩展名');
  if (explicit && fs.existsSync(vsix)) throw new Error('候选安装包已经存在；请复用该文件或使用新的输出目录');
  fs.mkdirSync(path.dirname(vsix), { recursive: true });

  fs.mkdirSync(BUILD, { recursive: true });
  const STAGE = fs.mkdtempSync(path.join(BUILD, 'stage-'));
  try {
  const extensionDir = path.join(STAGE, 'extension');
  fs.mkdirSync(extensionDir, { recursive: true });

  for (const item of SHIP) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) {
      throw new Error(`清单里的东西不存在：${item}（清单在 tools/ship-list.js）`);
    }
    copyInto(from, path.join(extensionDir, item));
  }
  fs.writeFileSync(path.join(extensionDir, 'README.md'), renderedReadme(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')));

  // 2) 两个描述文件（不得包含 BOM，否则 VS Code 解析失败）
  fs.writeFileSync(path.join(STAGE, 'extension.vsixmanifest'), manifestXml(manifest), 'utf8');
  fs.writeFileSync(path.join(STAGE, '[Content_Types].xml'), contentTypesXml(), 'utf8');

  // 3) 打包为 zip（使用 .NET 的实现，该实现在 .NET Core 上写入正斜杠路径，符合 vsix 要求）
  if (!explicit && path.dirname(path.resolve(vsix)) !== path.resolve(BUILD)) throw new Error('安装包路径超出构建边界');
  createArchive(STAGE, vsix);

  // 4) 自检：读回 zip 中的条目名，确认路径使用正斜杠且必需条目齐全
  const entries = archiveEntries(vsix);

  const problems = [];
  if (entries.some((name) => name.includes('\\'))) problems.push('有条目名用了反斜杠（vsix 会装不上）');
  for (const required of ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/src/extension.js']) {
    if (!entries.includes(required)) problems.push(`缺少条目：${required}`);
  }

  const size = (fs.statSync(vsix).size / 1024).toFixed(1);
  console.log(`\n打包完成：${vsix}`);
  console.log(`  版本 ${manifest.version}，${entries.length} 个条目，${size} KB`);
  if (problems.length) {
    console.error('  ❌ 自检没过：');
    for (const problem of problems) console.error(`     - ${problem}`);
    throw new Error('候选安装包结构检查失败');
  }
  console.log('  ✅ 自检通过（结构完整、条目名规范）');
  checkArchiveReadme(vsix);
  return vsix;
  } finally {
    fs.rmSync(STAGE, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { manifestXml, contentTypesXml, createArchive, archiveEntries, buildVsix: main };
