'use strict';

/**
 * 把扩展打成一个 .vsix（本地安装用，不发商店）。
 *
 * 为什么自己写而不是用 @vscode/vsce：
 * 1. vsix 就是一个特定结构的 zip，规则很固定，自己打完全可控；
 * 2. 不用往这台机器上再装一个 npm 包（少一份污染，也少一处会坏的地方）；
 * 3. 什么时候想改打包内容，改一个数组就行。
 *
 * vsix 的结构：
 *   extension.vsixmanifest    声明（标识、版本、依赖的 VS Code 版本、资源清单）
 *   [Content_Types].xml       zip 里每种文件扩展名的 MIME 声明
 *   extension/**              扩展本体（package.json 必须在 extension/ 根下）
 *
 * 用法：node tools/build-vsix.mjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'stage');

/** 要打进 vsix 的东西（相对扩展根目录）。测试与工具目录不打包。 */
const SHIP = ['package.json', 'README.md', 'src', 'media'];

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

/** zip 里每种扩展名的 Content-Type；漏一种就有文件装不进去。 */
const CONTENT_TYPES = {
  '.json': 'application/json',
  '.js': 'application/javascript',
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
    .map(([ext, type]) => `  <Default Extension="${ext}" ContentType="${type}"/>`)
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

function main() {
  const manifest = readManifest();

  // 1) 清空并重新搭台
  fs.rmSync(BUILD, { recursive: true, force: true });
  const extensionDir = path.join(STAGE, 'extension');
  fs.mkdirSync(extensionDir, { recursive: true });

  for (const item of SHIP) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) {
      console.warn(`  ⚠ 跳过不存在的文件：${item}`);
      continue;
    }
    copyInto(from, path.join(extensionDir, item));
  }

  // 2) 两个描述文件（必须没有 BOM，否则 VS Code 解析会炸）
  fs.writeFileSync(path.join(STAGE, 'extension.vsixmanifest'), manifestXml(manifest), 'utf8');
  fs.writeFileSync(path.join(STAGE, '[Content_Types].xml'), contentTypesXml(), 'utf8');

  // 3) 打成 zip（用 .NET 的实现，它在 .NET Core 上写的是正斜杠，符合 vsix 要求）
  const vsix = path.join(BUILD, `${manifest.name}-${manifest.version}.vsix`);
  execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(STAGE, '*')}' -DestinationPath '${vsix}' -Force`,
    ],
    { stdio: 'inherit' },
  );

  // 4) 自检：把 zip 里的条目名读回来，确认用的正斜杠、且该有的都在
  const check = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$z=[System.IO.Compression.ZipFile]::OpenRead('${vsix}'); ` +
        `$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`,
    ],
    { encoding: 'utf8' },
  );
  const entries = check.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

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
    process.exit(1);
  }
  console.log('  ✅ 自检通过（结构完整、条目名规范）');
}

main();
