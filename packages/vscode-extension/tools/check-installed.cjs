'use strict';
// 检查装入 VS Code 的扩展与仓库源码是否一致。
// VSCE 会把 LICENSE 改名为 LICENSE.txt，并把 README 中的相对仓库链接改写为
// GitHub 绝对链接；核对标准打包转换和 Git 换行差异，其余正文须一致。
//
// 设置该工具的原因：修改源码后必须完成「重新打包 → 重新安装」两个步骤，而
// 安装版本号不能证明发行文件与当前源码一致，因此需要逐文件比对。
//
// 用法：node tools/check-installed.cjs   （在 packages/vscode-extension 目录下运行）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 本脚本位于扩展目录内，因此 ".." 即扩展根目录。
const SRC = path.resolve(__dirname, '..');
// 装入的文件清单：由 tools/ship-list.js 提供（仅此一份清单，不再重复维护）。
const { shipFiles } = require('./ship-list');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
// 安装目录名 = `<publisher>.<name>-<version>`（VS Code 的命名规则）。publisher 自 0.1.3 起
// 为市场使用的 ID，因此此处依据清单计算，不再写死 `local.`；大小写亦按实际目录做兼容处理。
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
try { require('./package-links.cjs').verifyPackageFiles(SRC, DST, { installed: true }); }
catch (error) { drift.push(error.message); }

console.log(`版本 ${manifest.version}，比对 ${files.length} 个文件`);
console.log(`安装位置 ${DST}`);
if (drift.length) {
  console.log(`\n❌ 有 ${drift.length} 处不一致（用户跑的不是当前源码）：`);
  for (const d of drift) console.log('   - ' + d);
  console.log('\n重打包重装：');
  console.log('  node tools/publish.js');
  console.log('  code --install-extension "build\\'
    + manifest.name + '-' + manifest.version + '.vsix" --force');
  console.log('  然后执行 Developer: Reload Window');
  process.exit(1);
}
console.log('\n✅ 发行内容与当前源码一致（标准打包转换已核对）');
