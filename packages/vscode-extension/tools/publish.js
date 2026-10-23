#!/usr/bin/env node
'use strict';
/** Verify an already accepted candidate, then upload those exact bytes. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { argsOf } = require('../../../tools/compat/lib.cjs');
const { quoteArg } = require('../src/door/locate');
const ROOT = path.resolve(__dirname, '..');

function publishPanel(args = process.argv.slice(2), dependencies = {}) {
  const options = argsOf(args);
  if (Object.keys(options).some(key => !['yes', 'candidate', 'report'].includes(key))) throw new Error('发布不接受升版本或重新打包参数；请先准备版本、候选包和验收报告');
  if (options.yes !== undefined && options.yes !== true) throw new Error('--yes 不接受参数');
  if (typeof options.candidate !== 'string') throw new Error('需要 --candidate 指定已构建的 VSIX；候选构建入口：node tools/bridge/packages.cjs --out build/candidates');
  const candidate = path.resolve(options.candidate);
  const spawn = dependencies.spawn || spawnSync;
  const verify = dependencies.verify || require('../../../tools/bridge/packages.cjs').verifyCandidate;
  const approve = dependencies.approve || require('../../../tools/compat/release-check.cjs').readReleaseApproval;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.private === true || !pkg.publisher || /^TODO/i.test(pkg.publisher) || !pkg.license || pkg.license === 'UNLICENSED' || !pkg.repository?.url || /TODO/.test(pkg.repository.url)) throw new Error('发布元数据不完整');
  const checked = spawn(process.execPath, [path.resolve(ROOT, '../../tools/check-public-paths.cjs')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (checked.status !== 0) throw new Error('公开内容检查未通过');
  const artifact = verify(candidate, 'vsix');
  if (options.yes) {
    if (typeof options.report !== 'string') throw new Error('正式发布需要 --report 指定当前候选的完整通过验收报告');
    approve(candidate, path.resolve(options.report), 'vsix');
    if (!(dependencies.env || process.env).VSCE_PAT) throw new Error('未设置 VSCE_PAT；凭据由 vsce 使用');
    const final = verify(candidate, 'vsix');
    if (final.sha256 !== artifact.sha256) throw new Error('候选安装包在发布检查期间发生变化');
    approve(candidate, path.resolve(options.report), 'vsix');
    const argv = ['--yes', '@vscode/vsce@4.0.0', 'publish', '--packagePath', candidate];
    const result = spawn('npx', process.platform === 'win32' ? argv.map(quoteArg) : argv, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (result.status !== 0) throw new Error('VSIX 上传失败');
  } else {
    if (options.report) approve(candidate, path.resolve(options.report), 'vsix');
    console.log(`候选包检查通过：${candidate}\nSHA-256 ${artifact.sha256}\n正式发布需同时提供 --yes --candidate <VSIX> --report <release-report.json>`);
  }
  return artifact;
}
if (require.main === module) {
  try { publishPanel(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { publishPanel };
