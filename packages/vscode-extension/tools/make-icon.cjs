#!/usr/bin/env node
/*
 * 生成市场使用的扩展图标 media/icon.png（128×128，VS Code 市场的要求）。
 *
 * 图形使用与活动栏一致的 DeepSeek 鲸鱼；市场版本增加品牌蓝渐变底与一个小型终端提示符，
 * 用于区分“DeepSeek 本体”与“连接 DSH 的 VS Code 面板”。活动栏版本仍保持 currentColor，
 * 市场图标则必须为自带颜色的位图。
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
/** DeepSeek 品牌蓝；由深至浅的渐变保证白色鲸鱼在小尺寸下仍有稳定对比度。 */
const BG = '#4d6bfe';

if (!fs.existsSync(CHROME)) {
  console.error(missingChromeMessage());
  process.exit(1);
}

// 活动栏的单色鲸鱼原样嵌入，只在市场图标中替换为白色并放大。
const GLYPH = fs
  .readFileSync(path.join(ROOT, 'media', 'dsh.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/currentColor/g, '#ffffff')
  .replace('<svg ', '<svg class="whale" width="108" height="92" ');

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 128px; height: 128px; overflow: hidden; background: transparent; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tile {
    position: relative;
    width: 128px;
    height: 128px;
    overflow: hidden;
    border-radius: 26px;
    background: linear-gradient(145deg, #263eb8 0%, ${BG} 58%, #79a7ff 100%);
  }
  .whale {
    position: absolute;
    left: 8px;
    top: 16px;
    filter: drop-shadow(0 3px 4px rgba(13, 31, 96, 0.22));
  }
  .terminal {
    position: absolute;
    right: 9px;
    bottom: 9px;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    background: #ffffff;
    box-shadow: 0 3px 8px rgba(13, 31, 96, 0.28);
  }
  .terminal::before {
    content: '';
    position: absolute;
    left: 9px;
    top: 9px;
    width: 9px;
    height: 9px;
    border-top: 4px solid #3d5ce7;
    border-right: 4px solid #3d5ce7;
    transform: rotate(45deg);
  }
  .terminal::after {
    content: '';
    position: absolute;
    left: 9px;
    right: 7px;
    bottom: 7px;
    height: 3px;
    border-radius: 2px;
    background: #35c8ee;
  }
</style>
<div class="tile">${GLYPH}<span class="terminal"></span></div>
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

console.log(`✅ media/icon.png：128×128，${(png.length / 1024).toFixed(1)} KB，DeepSeek 鲸鱼 + 终端标记，底色 ${BG}`);
