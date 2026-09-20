'use strict';

/**
 * 将预览页面截取为图片，使界面的实际呈现可被直接查看。
 *
 * 需要该工具的原因：此前一直以断言描述界面（检查项数量、对比度比值），
 * 但断言无法证明"呈现是否正确" —— 间距是否过密、文字是否被截断、卡片是否对齐，
 * 这些只能通过观察图像判断。截取图片后，改动效果亦可进行前后对比。
 *
 * 使用与界面测试**同一套** HTML / CSS / 主题变量（由 tools/preview.js 生成），
 * 因此所见的即为 VS Code 中的实际呈现，并非另一份"预览版"。
 *
 * 用法：
 *   node tools/shots.js              # 截取全部场景 × 两个主题
 *   node tools/shots.js chat         # 仅截取某个场景
 *   node tools/shots.js chat light   # 仅截取某个场景的某个主题
 *
 * 输出：shots/<场景>-<主题>.png
 *
 * 不放入 build/ 目录的原因：`node tools/build-vsix.js` 会清空整个 build/
 * （该目录为其临时区），已截取的图片会被一并删除 —— 首次使用时即因此丢失。因此存放于
 * 不会被任何脚本清理的位置，并在 .gitignore 中列出（图片不纳入版本库）。
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
          // 使回放脚本执行完场景后再截图（与界面测试使用同一个等待窗口）。
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
