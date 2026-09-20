#!/usr/bin/env node
/*
 * 把扩展发到 VS Code 市场（或先打一个市场包看看里面有什么）。
 *
 * 为什么不直接在 package.json 里写 `vsce publish`：这个仓库有两个坑，
 * 一脚踩下去都是"看起来发了、其实是错的"。
 *
 *   1. **publisher 和 repository 里还留着占位符**（`TODO-your-publisher-id`、
 *      `TODO-owner/TODO-repo`）。带着占位符发布，轻则 403，重则发到一个不是你的
 *      publisher 名下、或者市场页面上的链接全指向别人的仓库。所以这里先自检，
 *      **不给 `--force` 就不发**。
 *   2. 这个扩展一直是自制的 tools/build-vsix.js 在打包（白名单：src/media/README/
 *      package.json）。市场的包要用官方 `vsce`，黑名单在 .vscodeignore 里。两条路
 *      必须打得进同一批文件，否则"本地装的是对的、市场用户装的是缺的"。
 *      所以这里打完包会**把包里的文件列出来**，让你一眼比对。
 *
 * 凭据：绝不读取、绝不打印。`vsce` 自己认环境变量 `VSCE_PAT`（或 `vsce login`）。
 * 这个脚本只负责"它不在就明确告诉你"。
 *
 * 用法：
 *   node tools/publish.js                  # 彩排：自检 + 打市场包 + 列出包内文件
 *   node tools/publish.js --yes            # 真发布（需要 VSCE_PAT）
 *   node tools/publish.js --yes --patch    # 版本号 +0.0.1 再发
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const go = args.includes('--yes') || args.includes('--force');
const bump = args.includes('--patch') ? ['patch'] : [];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];
const checks = [];

function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  if (!ok) problems.push(label);
}

check(!/^TODO/i.test(pkg.publisher || ''), 'publisher 已经改成市场账号（不是 TODO 占位）', pkg.publisher);
const repoUrl = (pkg.repository && pkg.repository.url) || '';
check(repoUrl && !/TODO/.test(repoUrl), 'repository 已经填成真实仓库地址', repoUrl || '（空）');
check(pkg.license && pkg.license !== 'UNLICENSED', 'license 已经不是 UNLICENSED', pkg.license);
check(pkg.private !== true, 'private 已经去掉（留着它 vsce 会拒绝发布）', String(pkg.private));
check(
  fs.existsSync(path.join(ROOT, pkg.icon || '')),
  `图标在（${pkg.icon || '没配'}）`,
  pkg.icon || '',
);
check(fs.existsSync(path.join(ROOT, 'LICENSE')), '有 LICENSE 文件', 'LICENSE');
check(fs.existsSync(path.join(ROOT, 'CHANGELOG.md')), '有 CHANGELOG.md', 'CHANGELOG.md');
check(fs.existsSync(path.join(ROOT, '.vscodeignore')), '有 .vscodeignore（市场包不带测试/截图）', '.vscodeignore');
// README 断链检查：市场页面会把这些相对路径改写成仓库 raw 地址，写错了就是一片破图。
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
const missing = images.filter((src) => !/^https?:/.test(src) && !fs.existsSync(path.join(ROOT, src)));
check(missing.length === 0, 'README 里的图片都在（相对路径按仓库根算）', missing.join(', ') || `${images.length} 张`);

console.log(`  发布自检：${pkg.name}@${pkg.version}`);
for (const item of checks) console.log(`  ${item.ok ? '✅' : '❌'} ${item.label}${item.detail ? `  （${item.detail}）` : ''}`);

if (problems.length) {
  console.log(`\n  ⚠️ 有 ${problems.length} 项没准备好。先解决它们（见 docs/发布清单.md），或者把占位符换成真值再跑。`);
  if (go) {
    console.log('  --yes 被拒绝了：带着占位符发布不是"先发出去再说"，是发错账号/错仓库。');
    process.exit(1);
  }
}

function vsce(extra) {
  const r = spawnSync('npx', ['--yes', '@vscode/vsce', ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  return r.status === 0;
}

/** `vsce ls` 打出来的文件清单（市场包最终会带哪些文件）。 */
function vsceFiles() {
  const r = spawnSync('npx', ['--yes', '@vscode/vsce', 'ls', '--no-dependencies'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    // vsce 只印文件路径（一行一个），但偶尔混进 "DONE Packaged: ..." 这类状态行 ——
    // 带空格的、以及明显是状态行的都排掉。注意**不能**按"有没有扩展名"过滤：
    // LICENSE 就没有扩展名，早期版本就是这么把它误判成漂移的。
    .filter((line) => line && !/\s/.test(line) && !/^(DONE|WARNING|ERROR|Packaged)/i.test(line))
    .map((line) => line.split('\\').join('/'))
    .sort();
}

/** 自产打包（build-vsix.js）与市场打包（vsce）必须是同一批文件，否则本地装的是对的、用户装的是缺的。 */
function compareWithShipList() {
  const { shipFiles } = require('./ship-list');
  const mine = shipFiles(ROOT);
  const theirs = vsceFiles();
  const onlyMine = mine.filter((f) => !theirs.includes(f));
  const onlyTheirs = theirs.filter((f) => !mine.includes(f));
  if (onlyMine.length || onlyTheirs.length) {
    console.log('  ❌ 两条打包路径的文件不一样：');
    if (onlyMine.length) console.log(`     只有 build-vsix.js 打进去：${onlyMine.join(', ')}`);
    if (onlyTheirs.length) console.log(`     只有 vsce 打进去：${onlyTheirs.join(', ')}`);
    console.log('     修法是改 tools/ship-list.js 或 .vscodeignore，让两边一致。');
    return false;
  }
  console.log(`  ✅ 两条打包路径一致（${mine.length} 个文件）`);
  return true;
}

// 彩排：打一个包，并把里面的文件列出来（跟 build-vsix.js 的结果比对）。
if (!go) {
  console.log('\n  ── 彩排：打市场包（不发布） ─────────────────────────────');
  const out = path.join(ROOT, 'build', `${pkg.name}-${pkg.version}.vsix`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!vsce(['package', '--no-dependencies', '--out', out])) process.exit(1);
  console.log(`\n  产物：${out}`);
  console.log('  包内文件（应当只有 src/ media/ README/LICENSE/CHANGELOG/package.json/icon）：');
  if (!vsce(['ls', '--no-dependencies'])) process.exit(1);
  console.log('');
  const same = compareWithShipList();
  console.log('\n  彩排结束。要真发布：先设好 VSCE_PAT，再 node tools/publish.js --yes');
  process.exit(same ? 0 : 1);
}

if (!process.env.VSCE_PAT) {
  console.log('\n  ❌ 环境变量 VSCE_PAT 没设。市场发布必须用它（我不会要、也不会读你的 token）：');
  console.log('     $env:VSCE_PAT = "<你自己的 Azure DevOps Personal Access Token>"');
  console.log('     node tools/publish.js --yes');
  process.exit(1);
}

console.log('\n  ── 真发布 ───────────────────────────────────────────────');
if (!vsce(['publish', ...bump, '--no-dependencies'])) process.exit(1);
console.log('\n  ✅ 发出去了。市场页面通常几分钟内可见：https://marketplace.visualstudio.com/items?itemName=' + `${pkg.publisher}.${pkg.name}`);
