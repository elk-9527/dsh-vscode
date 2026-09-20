#!/usr/bin/env node
/*
 * 生成市场用的扩展图标 media/icon.png（128×128，VS Code 市场的要求）。
 *
 * 为什么要这么绕：仓库里唯一的图形资源是 media/dsh.svg，而它是**活动栏图标** ——
 * 24×24、单色、用 currentColor 上色（跟着主题走）。市场图标必须是**自带颜色**的
 * 位图：市场页面不在 VS Code 里，没有主题变量可继承，灰色描边放上去等于看不见。
 *
 * 所以这里把同一个图形放到一块品牌色底上，用**已经装好的无头 Chrome** 渲染成
 * PNG（跟 tools/shots.js 一个路子，不额外引入图形库、也不联网）。
 *
 * 用法：node tools/make-icon.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(ROOT, 'media', 'icon.png');
const STAGE = path.join(ROOT, 'build', 'icon');
/** 底色的选择：VS Code 深色主题里那个主按钮蓝，放市场上既显眼又不扎眼。 */
const BG = '#0e639c';

if (!fs.existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}（改这一行指到你机器上的 chrome.exe）`);
  process.exit(1);
}

// 活动栏那个图形（24×24 的 viewBox），原样嵌进来，只换颜色和大小。
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

// 尺寸必须真的是 128×128：市场会拒绝别的尺寸，而且这事肉眼看不出来。
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
