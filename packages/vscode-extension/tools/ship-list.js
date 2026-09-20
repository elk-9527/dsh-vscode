'use strict';

/**
 * 「装进 vsix 的东西」——**只有这一份清单**。
 *
 * 为什么单独拎出来：这份清单原来在三个地方各写了一遍（tools/build-vsix.js 的
 * SHIP、tools/check-installed.cjs 的 SHIP、test/static.js 里那个 vsixFiles 数组），
 * 于是每次加一个文件（比如这次的 icon.png、LICENSE）都得记得三处一起改 ——
 * 漏一处就是"本地装的是对的、市场包里少一个文件"这种只在用户那边才炸的事故。
 *
 * 现在：打包（build-vsix.js）、核对装机（check-installed.cjs）、发布前的漂移检查
 * （tools/publish.js 拿它跟 `vsce ls` 的输出逐个比对）、测试（test/static.js）
 * 都读这一份。.vscodeignore 是**另一侧**的黑名单，两边必须覆盖同一批文件 ——
 * test/static.js 有一条断言盯着"扩展目录下的每个顶层条目要么在这份清单里、
 * 要么在 .vscodeignore 里"。
 *
 * 注意：清单里的目录是**递归全收**。想排除目录里的某个文件，得在 .vscodeignore
 * 里写（vsce 走黑名单），build-vsix.js 那边是全收 —— 所以别往里放会被忽略的东西。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 相对扩展根目录：文件写全名，目录写目录名。 */
const SHIP = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'src', 'media'];

/**
 * 把 SHIP 展开成具体文件（相对路径，正斜杠），按字典序。
 * 不存在的条目直接跳过（由调用方各自报告 —— 装机核对要"缺了就报"，
 * 打包要"缺了就警告"）。
 */
function shipFiles(root) {
  const files = [];
  const walk = (relative) => {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full)) walk(path.join(relative, entry));
      return;
    }
    files.push(relative.split(path.sep).join('/'));
  };
  for (const item of SHIP) walk(item);
  return files.sort();
}

module.exports = { SHIP, shipFiles };
