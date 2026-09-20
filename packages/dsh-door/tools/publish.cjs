#!/usr/bin/env node
/*
 * 将 ACP 接入点插件（`dsh-acp-door`）发布到 npm（DSH 的插件市场从 npm / GitHub Release 安装）。
 *
 * 背景（2026-09-20 查证）：DSH 的"插件市场"不是一个上传后台，
 * 而是 —— ① 官方客户端中的市场（dsh-market / dsh-community-market）与
 * ② 目录站，两者都读取同一份**精选列表** `awesome-dsh-plugin/awesome-dsh-plugin`。
 * 上架的完整步骤是：
 *
 *   1. 将包发布到 npm（可选，但建议执行：市场安装插件优先采用"经仓库验证的 npm 包"）；
 *   2. 向该精选列表提交一个 PR，新增 **一个文件**
 *      `data/plugins/<owner>__<repo>.yml`（内容由本脚本打印，可直接复制）。
 *
 * 凭据：脚本不读取、不打印 token。`npm publish` 自行识别 `npm login` 或
 * 环境变量 `NODE_AUTH_TOKEN`（配置在 .npmrc 中）。
 *
 * 用法：
 *   node tools/publish.cjs          # 试运行：自检 + npm pack --dry-run + 打印拟提交的 PR 内容
 *   node tools/publish.cjs --yes    # 实际发布到 npm
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NPM_REGISTRY = 'https://registry.npmjs.org';
const go = process.argv.slice(2).includes('--yes');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const repoUrl = (pkg.repository && pkg.repository.url) || '';
const dir = (pkg.repository && pkg.repository.directory) || '';
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
const owner = m ? m[1] : 'TODO-owner';
const repo = m ? m[2] : 'TODO-repo';
const problems = [];

function check(ok, label, detail) {
  if (!ok) problems.push(label);
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  （${detail}）` : ''}`);
}

console.log(`  发布自检：${pkg.name}@${pkg.version}`);
check(pkg.private !== true, 'private 已经去掉', String(pkg.private));
check(Boolean(pkg.license) && pkg.license !== 'UNLICENSED', 'license 已填', pkg.license);
check(Boolean(m) && !/TODO/.test(repoUrl), 'repository 是真实 GitHub 地址', repoUrl || '（空）');
check(
  Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch),
  '声明了 dsh.bundle（市场收录的硬要求）',
  JSON.stringify(pkg.dsh || {}),
);
check(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml 在包根', 'cordis.patch.yml');
check(fs.existsSync(path.join(ROOT, 'README.md')), '有 README.md（市场卡片就靠它）', 'README.md');
check(fs.existsSync(path.join(ROOT, 'CHANGELOG.md')), '有 CHANGELOG.md', 'CHANGELOG.md');

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const urls = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((x) => x[1]);
check(
  urls.length > 0,
  'README 里有截图（GitHub 页面要靠它；市场那边另看 screenshots.json）',
  `${urls.length} 张`,
);
const brokenImages = urls.filter((src) => !/^https?:/.test(src) && !fs.existsSync(path.join(ROOT, src)));
check(brokenImages.length === 0, 'README 里的图片都在（相对路径按本包目录算）', brokenImages.join(', ') || '都在');

/*
 * 市场的截图清单：**放在本仓库**（`screenshots.json`，与 package.json 同级）——
 * 上游 contributing.md 明确要求如此：写死在上游仓库的绝对 URL 会失效
 * （已发布的 773 张中有 41 张即因此返回 404），相对路径在本仓库改名后可立即发现。
 * 规则：1–8 张；相对路径不能以 / 开头、不能含 ..；也接受 GitHub 托管的 https 绝对地址。
 */
const shotFile = path.join(ROOT, 'screenshots.json');
let shots = null;
if (fs.existsSync(shotFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(shotFile, 'utf8'));
    shots = Array.isArray(raw) ? raw : raw && raw.screenshots;
  } catch (err) {
    shots = null;
  }
}
check(Array.isArray(shots) && shots.length >= 1 && shots.length <= 8, 'screenshots.json 合法（1–8 张）', Array.isArray(shots) ? `${shots.length} 张` : '解析失败/没有');
if (Array.isArray(shots)) {
  const bad = shots.filter(
    (src) => typeof src !== 'string' || (!/^https?:/.test(src) && (/^[\\/]/.test(src) || src.includes('..') || !fs.existsSync(path.join(ROOT, src)))),
  );
  check(bad.length === 0, '截图路径都在本包里、且没跳出目录', bad.join(', ') || '都在');
}

// 打包生成的 tarball 实际含有的文件 —— 应当只包含 lib / cordis.patch.yml / README / CHANGELOG / LICENSE。
console.log('\n  ── 包内文件（npm pack --dry-run）─────────────────────────');
const pack = spawnSync('npm', ['pack', '--dry-run'], { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
if (pack.status !== 0) process.exit(1);

const entry = [
  `url: https://github.com/${owner}/${repo}/tree/main/${dir || 'packages/dsh-door'}`,
  `name: ${owner}/${repo}${dir ? '#dsh-door' : ''}`,
  'category: dev',
  'description:',
  "  en: 'Loopback-only ACP door for DeepSeek Harness: attach an external client (such as the DSH Panel VS Code extension) to the kernel you already have running, exposing session listing and permission presets.'",
  '  zh: 为正在运行的 DeepSeek Harness 内核新增一个仅监听本机回环地址的 ACP 接入点，供外部客户端（如 VS Code 的 DSH 面板）连接同一个内核，并接出会话列表与权限预设。',
].join('\n');

console.log('\n  ── 上架精选列表要提的那个文件 ───────────────────────────');
console.log(`  文件名：data/plugins/${owner}__${repo}${dir ? `--${dir.replace(/\//g, '-')}` : ''}.yml`);
console.log('  内容：\n');
console.log(
  entry
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n'),
);
console.log('\n  提到这里：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin');
console.log('  （一个文件就是全部投稿；README 由他们的脚本生成，别手工改。）');

if (!go) {
  console.log('\n  彩排结束。真发到 npm：先 npm login --registry=https://registry.npmjs.org（或配好 NODE_AUTH_TOKEN），再 node tools/publish.cjs --yes');
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.log(`\n  ❌ 还有 ${problems.length} 项没准备好（见上），先解决再发。`);
  process.exit(1);
}
console.log('\n  ── 真发布到 npm 官方注册表 ──────────────────────────────');
const pub = spawnSync('npm', ['publish', '--access', 'public', '--registry', NPM_REGISTRY], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
});
if (pub.status !== 0) process.exit(1);
console.log(`\n  ✅ 已发布：https://www.npmjs.com/package/${pkg.name}`);
console.log('     接着把上面那份 yml 提到 awesome-dsh-plugin，市场通常一天内收录。');
