#!/usr/bin/env node
/*
 * 生成市场使用的扩展图标 media/icon.png（128×128，VS Code 市场的要求）。
 *
 * 市场图标使用蓝发女仆形象，用于表达 DSH 的拟人化形象。
 * 活动栏版本仍保持 currentColor 单色图形，
 * 市场图标则使用自带颜色的位图。
 *
 * 高分辨率母版放在 tools/assets/icon-source.png；此脚本使用**本机已安装的无头 Chrome**
 * 缩放为 PNG（与 tools/shots.js 采用同一方式，不额外引入图形库，也不联网）。
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
const SOURCE = path.join(ROOT, 'tools', 'assets', 'icon-source.png');
const STAGE = path.join(ROOT, 'build', 'icon');

if (!fs.existsSync(CHROME)) {
  console.error(missingChromeMessage());
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) {
  console.error(`缺少图标母版：${SOURCE}`);
  process.exit(1);
}

// 使用 data URL，避免无头 Chrome 对本地文件访问策略的差异。
const sourceDataUrl = `data:image/png;base64,${fs.readFileSync(SOURCE).toString('base64')}`;
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 128px;
    height: 128px;
    overflow: hidden;
    background: #ffffff;
  }
  img { display: block; width: 128px; height: 128px; }
</style>
<img src="${sourceDataUrl}" alt="">
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

console.log(
  `✅ media/icon.png：128×128，${(png.length / 1024).toFixed(1)} KB，蓝发女仆`,
);
