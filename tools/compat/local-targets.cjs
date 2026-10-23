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
  const resolve = file => {
    if (fs.existsSync(file)) return fs.realpathSync(file);
    assert(!fs.lstatSync(file, {throwIfNoEntry: false})?.isSymbolicLink(), '隔离验收 DSH_HOME 不能经过失效链接');
    return path.join(resolve(path.dirname(file)), path.basename(file));
  };
  const resolved = resolve(home);
  assert(inside(resolved, build) && resolved !== build, '隔离验收 DSH_HOME 不能通过链接指向其他位置');
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
  const hashes = [];
  const packages = require('../bridge/packages.cjs');
  for (const profile of ['desktop', 'vscode-panel']) {
    const directory = path.join(home, 'profiles', profile);
    assert(json(path.join(directory, 'package.json')).dsh.profile.bundles.includes('dsh-acp-door'));
    packages.verifyInstalledCandidate(candidates.tgz, path.join(directory, 'node_modules/dsh-acp-door'), { root: home });
    for (const [file, hash] of Object.entries(candidates.tgz.files)) hashes.push({ profile, file, sha256: hash });
  }
  packages.verifyInstalledCandidate(candidates.vsix, extension);
  return { doorFilesPerProfile: Object.keys(candidates.tgz.files).length, files: hashes, panel: { verified: true },
    targets: { home: path.resolve(home), extension: path.resolve(extension) },
    artifacts: ['tgz', 'vsix'].map(kind => ({ kind, sha256: candidates[kind].sha256 })) };
}

function isolatedEnvironment(home, cacheRoot) {
  home = dedicatedHome(home);
  const cache = cacheRoot || path.join(home, '.acceptance-cache');
  const folders = {APPDATA:'roaming', LOCALAPPDATA:'local', PNPM_HOME:'pnpm-home', npm_config_cache:'npm',
    npm_config_store_dir:'pnpm-store', XDG_CACHE_HOME:'xdg-cache', TEMP:'tmp', TMP:'tmp', TMPDIR:'tmp'};
  const result = {DSH_HOME:home};
  for (const [key, name] of Object.entries(folders)) result[key] = dedicatedHome(path.join(cache, name));
  return result;
}
module.exports = { dedicatedHome, verifyInstallation, isolatedEnvironment };
