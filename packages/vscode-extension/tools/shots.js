'use strict';

/**
 * 把预览页面拍成图片，好让「界面长什么样」这件事是能被看见的。
 *
 * 为什么需要：这一夜我一直在用断言描述界面（多少项检查、对比度多少比多少），
 * 但那证明不了"看起来对不对" —— 间距挤不挤、文字会不会被截断、卡片歪没歪，
 * 这些只能用眼睛看。拍图之后，改动的效果也能前后对比。
 *
 * 用的是跟界面测试**同一套** HTML / CSS / 主题变量（tools/preview.js 生成），
 * 所以看到的就是 VS Code 里那个东西的样子，不是另一份"预览版"。
 *
 * 用法：
 *   node tools/shots.js              # 拍全部场景 × 两个主题
 *   node tools/shots.js chat         # 只拍某个场景
 *   node tools/shots.js chat light   # 只拍某个场景的某个主题
 *
 * 输出：shots/<场景>-<主题>.png
 *
 * 为什么不放 build/ 下面：`node tools/build-vsix.js` 会把整个 build/ 清掉
 * （那是它的临时区），拍好的图会跟着没了 —— 头一次就这么丢的。所以放在
 * 一个不会被任何脚本清掉的地方，并且在 .gitignore 里（图不进版本库）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCENARIOS, THEMES, OUT } = require('./preview');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function main() {
  const args = process.argv.slice(2);
  const onlyScene = args[0];
  const onlyTheme = args[1];

  if (!fs.existsSync(CHROME)) {
    console.log(`找不到 Chrome：${CHROME}`);
    process.exit(2);
  }
  if (!fs.existsSync(OUT)) {
    console.log(`先跑一次 node tools/preview.js 生成预览页面（${OUT} 不存在）`);
    process.exit(2);
  }

  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const shots = [];
  for (const scene of Object.keys(SCENARIOS)) {
    if (onlyScene && onlyScene !== scene) continue;
    for (const theme of Object.keys(THEMES)) {
      if (onlyTheme && onlyTheme !== theme) continue;
      const page = path.join(OUT, `${scene}-${theme}.html`);
      if (!fs.existsSync(page)) continue;
      const png = path.join(SHOTS, `${scene}-${theme}.png`);
      const result = spawnSync(
        CHROME,
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          '--force-device-scale-factor=2',
          '--window-size=420,900',
          // 让回放脚本把场景演完再截（跟界面测试同一个等待窗口）。
          '--virtual-time-budget=3000',
          `--screenshot=${png}`,
          `--user-data-dir=${path.join(ROOT, 'build', 'chrome-shots')}`,
          `file:///${page.replace(/\\/g, '/')}`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      if (result.status === 0 && fs.existsSync(png)) shots.push({ scene, theme, png });
    }
  }

  console.log(`拍了 ${shots.length} 张图：`);
  for (const shot of shots) {
    const size = (fs.statSync(shot.png).size / 1024).toFixed(0);
    console.log(`  ${path.relative(ROOT, shot.png)}  （${size} KB）`);
  }
  console.log(`\n输出目录：${SHOTS}`);
}

if (require.main === module) main();

module.exports = { SHOTS };
