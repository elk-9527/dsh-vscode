#!/usr/bin/env node
/*
 * 将扩展发布到 VS Code 市场（或先构建市场包并查看其中的内容）。
 *
 * 不在 package.json 中直接写入 `vsce publish` 的原因：本仓库存在两处隐患，
 * 触发后均表现为"看似发布成功、实际结果错误"。
 *
 *   1. **publisher 与 repository 字段中仍保留占位符**（`TODO-your-publisher-id`、
 *      `TODO-owner/TODO-repo`）。携带占位符发布，轻则返回 403，重则发布到他人的
 *      publisher 名下、或者市场页面上的链接全部指向他人仓库。因此此处先执行自检，
 *      **未提供 `--force` 时不执行发布**。
 *   2. 本扩展一直由自制的 tools/build-vsix.js 打包（白名单：src/media/README/
 *      package.json）。市场包使用官方 `vsce`，黑名单位于 .vscodeignore 中。两条
 *      路径必须包含同一批文件，否则会出现"本地安装的版本正确、市场用户安装的版本
 *      缺少文件"的情况。因此此处打包后会**把包内的文件列出来**，供直接比对。
 *
 * 凭据：不读取、不打印。`vsce` 自身识别环境变量 `VSCE_PAT`（或 `vsce login`）。
 * 本脚本仅负责在凭据缺失时明确提示。
 *
 * 用法：
 *   node tools/publish.js                  # 试运行：自检 + 打市场包 + 列出包内文件 + 与自产打包比对
 *   node tools/publish.js --yes            # 正式发布（需要 VSCE_PAT；版本号取自 package.json）
 *   node tools/publish.js --yes --patch    # 先递增 +0.0.1 再发布（同时支持 --minor / --major / --version 1.2.3）
 *
 * 每次更新均须**使用新的版本号**：市场不接受重复发布同一个版本号（仅修改 README 亦计为一次更新）。
 * 携带版本参数的调用会经由 `npm version` —— 该命令会自行创建一笔"版本号"提交并打 tag，
 * 因此**工作区必须保持干净**（本脚本会先行检查，若工作区有未提交改动则直接提示，避免发布过程中断）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const go = args.includes('--yes') || args.includes('--force');
/** 版本参数：patch / minor / major / x.y.z；未提供时按 package.json 中的现有版本号发布。 */
const bumpArg = (() => {
  for (const flag of ['patch', 'minor', 'major']) if (args.includes(`--${flag}`)) return flag;
  const at = args.indexOf('--version');
  if (at >= 0 && args[at + 1] && !args[at + 1].startsWith('-')) return args[at + 1];
  return null;
})();

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
// README 断链检查：市场页面会将这些相对路径改写为仓库 raw 地址，路径错误时图片无法显示。
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

/** `vsce ls` 输出的文件清单（市场包最终包含哪些文件）。 */
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
    // vsce 仅输出文件路径（一行一个），但偶尔混入 "DONE Packaged: ..." 这类状态行 ——
    // 含空格的条目、以及明显是状态行的条目一律排除。注意**不可**按"是否包含扩展名"过滤：
    // LICENSE 没有扩展名，早期版本正是因此将其误判为漂移。
    .filter((line) => line && !/\s/.test(line) && !/^(DONE|WARNING|ERROR|Packaged)/i.test(line))
    .map((line) => line.split('\\').join('/'))
    .sort();
}

/** 自产打包（build-vsix.js）与市场打包（vsce）必须包含同一批文件，否则会出现本地安装版本正确、用户安装版本缺少文件的情况。 */
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

// 试运行：构建一个包，并把其中的文件列出来（与 build-vsix.js 的结果比对）。
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
  console.log('  （市场不接受重发同一个版本号 —— 换版本就加 --patch / --minor / --major / --version 1.2.3）');
  process.exit(same ? 0 : 1);
}

if (!process.env.VSCE_PAT) {
  console.log('\n  ❌ 环境变量 VSCE_PAT 没设。市场发布必须用它（我不会要、也不会读你的 token）：');
  console.log('     $env:VSCE_PAT = "<你自己的 Azure DevOps Personal Access Token>"');
  console.log('     node tools/publish.js --yes');
  process.exit(1);
}

// 携带版本参数时会经由 `npm version`：该命令会自行创建一笔版本提交并打 tag。工作区存在
// 未提交改动时该步骤会失败，而此时 vsce 可能已完成打包 —— 与其在发布中途失败，应当现在说明。
if (bumpArg) {
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (dirty.status === 0 && dirty.stdout.trim()) {
    console.log('\n  ❌ 工作区不干净，不能用 --' + bumpArg + '（npm version 要先提交一笔版本提交）。');
    console.log('     先 git commit，或者改成不带版本参数（按 package.json 里现有的版本号发）：');
    console.log(`     当前版本 ${pkg.version} → 也可以自己改好 package.json 再提交。`);
    process.exit(1);
  }
  console.log(`\n  版本参数：${bumpArg}（会先 npm version ${bumpArg} —— 生成一笔版本提交 + tag v…）`);
  console.log('  ⚠️ 记得先把 CHANGELOG.md 里那一版写上：市场页面的「Changelog」就是读它。');
}

console.log('\n  ── 真发布 ───────────────────────────────────────────────');
if (!vsce(['publish', ...(bumpArg ? [bumpArg] : []), '--no-dependencies'])) process.exit(1);
// 携带版本参数时 package.json 已被 npm version 修改，重新读取一次才能获得正确的版本号。
const nowVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
console.log('\n  ✅ 发出去了。市场页面通常几分钟内可见：https://marketplace.visualstudio.com/items?itemName=' + `${pkg.publisher}.${pkg.name}`);
console.log('     （VS Code 里的用户会在下次检查更新时自动升到这一版。）');
console.log(`     本地那一份也需要同步更新：node tools/build-vsix.js 然后 code --install-extension build\\${pkg.name}-${nowVersion}.vsix`);
console.log('     还有：git push（版本提交与 tag 是 vsce 帮你打的），以及刷新备份。');
