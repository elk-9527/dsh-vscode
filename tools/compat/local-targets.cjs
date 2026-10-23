'use strict';
/** Explicit installation targets keep local acceptance independent of daily profiles. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { ROOT, json, contentSha256, sha256 } = require('./lib.cjs');
function inside(file, directory) {
  const relative = path.relative(directory, file);
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function dedicatedHome(value) {
  assert.equal(typeof value, 'string', '隔离验收需要明确的 DSH_HOME');
  const home = path.resolve(value), build = fs.realpathSync(path.join(ROOT, 'build'));
  assert(inside(home, build) && home !== build, '隔离验收 DSH_HOME 必须位于本项目 build 子目录');
  const resolve = file => fs.existsSync(file) ? fs.realpathSync(file) : path.join(resolve(path.dirname(file)), path.basename(file));
  assert(inside(resolve(home), build) && resolve(home) !== build, '隔离验收 DSH_HOME 不能通过链接指向其他位置');
  fs.mkdirSync(home, {recursive: true});
  const actual = fs.realpathSync(home);
  assert(inside(actual, build) && actual !== build, '隔离验收 DSH_HOME 不能通过链接指向其他位置');
  return actual;
}
function verifyInstallation({ home, extension, candidates }) {
  assert(home && extension, '装机校验需要明确的配置目录和扩展安装目录');
  for (const kind of ['tgz', 'vsix']) {
    const value = candidates?.[kind];
    assert(value?.file && value.sha256 === sha256(value.file), `装机校验缺少相同的候选 ${kind}`);
    require('../bridge/packages.cjs').verifyCandidate(value.file, kind);
  }
  const files = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];
  const walk = (base, prefix) => { for (const name of fs.readdirSync(base)) {
    const relative = path.join(prefix, name), file = path.join(base, name);
    if (fs.statSync(file).isDirectory()) walk(file, relative); else files.push(relative);
  } };
  walk(path.join(ROOT, 'packages/dsh-door/lib'), 'lib');
  const hashes = [];
  for (const profile of ['desktop', 'vscode-panel']) {
    const directory = path.join(home, 'profiles', profile);
    assert(json(path.join(directory, 'package.json')).dsh.profile.bundles.includes('dsh-acp-door'));
    for (const file of files) {
      const source = path.join(ROOT, 'packages/dsh-door', file), target = path.join(directory, 'node_modules/dsh-acp-door', file);
      assert.equal(contentSha256(target), contentSha256(source), `${profile}/${file} 内容不一致`);
      hashes.push({profile, file:file.replace(/\\/g, '/'), sha256:sha256(target), sourceSha256:sha256(source), contentSha256:contentSha256(target)});
    }
  }
  require('../../packages/vscode-extension/tools/package-links.cjs').verifyPackageFiles(path.join(ROOT, 'packages/vscode-extension'), extension, {installed:true});
  return {doorFilesPerProfile:files.length, files:hashes, panel:{verified:true}, targets:{home:path.resolve(home), extension:path.resolve(extension)},
    artifacts:['tgz','vsix'].map(kind=>({kind,sha256:candidates[kind].sha256}))};
}
function isolatedEnvironment(home) {
  home = dedicatedHome(home);
  const cache = path.join(home, '.acceptance-cache');
  const folders = {APPDATA:'roaming', LOCALAPPDATA:'local', PNPM_HOME:'pnpm-home', npm_config_cache:'npm',
    npm_config_store_dir:'pnpm-store', XDG_CACHE_HOME:'xdg-cache', TEMP:'tmp', TMP:'tmp', TMPDIR:'tmp'};
  const result = {DSH_HOME:home};
  for (const [key, name] of Object.entries(folders)) result[key] = dedicatedHome(path.join(cache, name));
  return result;
}
module.exports = { dedicatedHome, verifyInstallation, isolatedEnvironment };
