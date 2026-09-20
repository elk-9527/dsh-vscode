#!/usr/bin/env node
/*
 * 生成市场使用的扩展图标 media/icon.png（128×128，VS Code 市场的要求）。
 *
 * 采用该实现方式的原因：仓库中唯一的图形资源是 media/dsh.svg，而该文件是**活动栏图标** ——
 * 24×24、单色、以 currentColor 着色（随主题变化）。市场图标必须为**自带颜色**的
 * 位图：市场页面不在 VS Code 内，没有可继承的主题变量，灰色描边在页面上不可见。
 *
 * 因此此处将同一图形置于品牌色底上，使用**本机已安装的无头 Chrome** 渲染为
 * PNG（与 tools/shots.js 采用同一方式，不额外引入图形库，也不联网）。
 *
 * 用法：node tools/make-icon.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findChrome, missingChromeMessage } = require('./chrome.cjs');

const ROOT = path.join(__dirname, '..');
const CHROME = findChrome();
const OUT = path.join(ROOT, 'media', 'icon.png');
const STAGE = path.join(ROOT, 'build', 'icon');
/** 底色的选择：VS Code 深色主题中的主按钮蓝，在市场页面上具有足够辨识度且不造成视觉干扰。 */
const BG = '#0e639c';

if (!fs.existsSync(CHROME)) {
  console.error(missingChromeMessage());
  process.exit(1);
}

// 活动栏图形（24×24 的 viewBox），原样嵌入，仅替换颜色与尺寸。
const GLYPH = fs
  .readFileSync(path.join(ROOT, 'media', 'dsh.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/currentColor/g, '#ffffff')
  .replace('<svg ', '<svg width="94" height="94" ');

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 128px; height: 128px; overflow: hidden; }
  body {
    background: ${BG};
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
${GLYPH}
`;

fs.mkdirSync(STAGE, { recursive: true });
const page = path.join(STAGE, 'icon.html');
fs.writeFileSync(page, html, 'utf8');

const result = spawnSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--window-size=128,128',
    '--virtual-time-budget=1500',
    `--screenshot=${OUT}`,
    `--user-data-dir=${path.join(ROOT, 'build', 'chrome-icon')}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore', windowsHide: true },
);
if (result.status !== 0 || !fs.existsSync(OUT)) {
  console.error('渲染失败（Chrome 没吐出 PNG）');
  process.exit(1);
}

// 尺寸必须确为 128×128：市场会拒绝其它尺寸，且该问题无法通过肉眼观察发现。
const png = fs.readFileSync(OUT);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 128 || height !== 128) {
  console.error(`尺寸不对：${width}×${height}（要 128×128）`);
  process.exit(1);
}
if (png.subarray(1, 4).toString() !== 'PNG') {
  console.error('这不是 PNG');
  process.exit(1);
}

console.log(`✅ media/icon.png：128×128，${(png.length / 1024).toFixed(1)} KB，底色 ${BG}`);
