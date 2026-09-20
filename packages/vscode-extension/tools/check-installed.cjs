'use strict';
// 装进 VS Code 的那份扩展，跟仓库源码是不是逐字节一致？
// （有差异就意味着用户跑的其实是旧代码 —— 这个项目出过这种事。）
//
// 为什么需要它：改完源码必须「重新打包 → 重新安装」两步都做到，而
// "装了"和"装的是这一版"是两件事。用户报"你改的东西没生效"时，先跑这个。
//
// 用法：node tools/check-installed.cjs   （在 packages/vscode-extension 下跑）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 这个脚本就住在扩展里，所以 ".." 就是扩展根目录。
const SRC = path.resolve(__dirname, '..');
// 装进去的是哪几样：问 tools/ship-list.js（只有那一份清单，别再抄一遍）。
const { shipFiles } = require('./ship-list');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
// 安装目录名 = `<publisher>.<name>-<version>`（VS Code 的命名法）。publisher 从 0.1.3 起
// 是市场用的那个 ID，所以这里跟着清单算，别再写死 `local.`；大小写也按实际目录兜一下。
const EXTENSIONS_DIR = path.join(os.homedir(), '.vscode', 'extensions');
const EXT_DIR_NAME = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
const DST = (() => {
  const exact = path.join(EXTENSIONS_DIR, EXT_DIR_NAME);
  if (fs.existsSync(exact)) return exact;
  const found = fs.existsSync(EXTENSIONS_DIR)
    ? fs.readdirSync(EXTENSIONS_DIR).find((name) => name.toLowerCase() === EXT_DIR_NAME.toLowerCase())
    : undefined;
  return found ? path.join(EXTENSIONS_DIR, found) : exact;
})();

if (!fs.existsSync(DST)) {
  console.log(`❌ 没找到装着的那份：${DST}`);
  console.log(`   （版本 ${manifest.version} 还没装上去？先 node tools/build-vsix.js 再装。）`);
  process.exit(1);
}

const files = shipFiles(SRC);

const drift = [];
for (const rel of files) {
  const a = path.join(SRC, rel);
  const b = path.join(DST, rel);
  if (!fs.existsSync(b)) {
    drift.push(`${rel} —— 装进去的那份里没有这个文件`);
    continue;
  }
  if (fs.readFileSync(a).equals(fs.readFileSync(b))) continue;
  if (rel === 'package.json') {
    const x = JSON.parse(fs.readFileSync(a, 'utf8'));
    const y = JSON.parse(fs.readFileSync(b, 'utf8'));
    delete y.__metadata; // VS Code 自己塞的安装信息
    if (JSON.stringify(x) === JSON.stringify(y)) {
      console.log('  ℹ package.json 只多了 VS Code 自己塞的 __metadata（正常）');
      continue;
    }
  }
  drift.push(`${rel} —— 内容不一样`);
}

console.log(`版本 ${manifest.version}，比对 ${files.length} 个文件`);
console.log(`安装位置 ${DST}`);
if (drift.length) {
  console.log(`\n❌ 有 ${drift.length} 处不一致（用户跑的不是当前源码）：`);
  for (const d of drift) console.log('   - ' + d);
  console.log('\n重打包重装：');
  console.log('  node tools/build-vsix.js');
  console.log('  & "D:\\Microsoft VS Code\\bin\\code.cmd" --install-extension "build\\dsh-panel-'
    + manifest.version + '.vsix" --force');
  console.log('  然后让用户 Developer: Reload Window');
  process.exit(1);
}
console.log('\n✅ 装进去的跟源码逐字节一致');
