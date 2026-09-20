'use strict';

/**
 * 「装进 vsix 的内容」——**仅此一份清单**。
 *
 * 单独提取的原因：该清单原先在三个位置各写一份（tools/build-vsix.js 的
 * SHIP、tools/check-installed.cjs 的 SHIP、test/static.js 中的 vsixFiles 数组），
 * 因此每次新增一个文件（例如本次的 icon.png、LICENSE）均须同步修改三处 ——
 * 遗漏任一处的后果是"本地安装的版本正确、市场包中缺少一个文件"这类仅在用户侧显现的故障。
 *
 * 当前：打包（build-vsix.js）、装机核对（check-installed.cjs）、发布前的漂移检查
 * （tools/publish.js 将其与 `vsce ls` 的输出逐项比对）、测试（test/static.js）
 * 均读取这一份。.vscodeignore 是**另一侧**的黑名单，两侧必须覆盖同一批文件 ——
 * test/static.js 中有一条断言检查"扩展目录下的每个顶层条目要么位于本清单中、
 * 要么位于 .vscodeignore 中"。
 *
 * 注意：清单中的目录为**递归全收**。如需排除目录中的某个文件，须在 .vscodeignore
 * 中声明（vsce 走黑名单），build-vsix.js 一侧为全收 —— 因此不应将需要被忽略的内容放入清单。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 相对扩展根目录：文件写完整文件名，目录写目录名。 */
const SHIP = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'src', 'media'];

/**
 * 将 SHIP 展开为具体文件（相对路径，正斜杠），按字典序排列。
 * 不存在的条目直接跳过（由各调用方分别报告 —— 装机核对要求"缺失即报告"，
 * 打包要求"缺失即警告"）。
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
