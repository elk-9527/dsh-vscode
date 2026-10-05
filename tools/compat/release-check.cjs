'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, argsOf, json, versions, sha256, sourceState, runDir, writeReport, semver, redact } = require('./lib.cjs');
const REQUIRED = ['runtime', 'package', 'installation', 'startup', 'handshake', 'status', 'session', 'model-switch', 'preset-switch', 'stream', 'permissions', 'permission-request', 'permission-cancel', 'tools', 'history', 'resume', 'cancel', 'cleanup'];
const LOCAL = ['desktop-attach', 'desktop-closed-self-start', 'configuration-inheritance', 'real-model-tool', 'local-kernel-cleanup', 'vsix-editor', 'installed-files'];

function validateReport(report, current = versions(), state = sourceState()) {
  const issues = [];
  if (report.status !== 'passed') issues.push(`内核报告状态 ${report.status}`);
  if (report.packages?.door !== current.door || report.packages?.panel !== current.panel) issues.push('报告对应的插件版本已变化');
  if (report.source?.fingerprint !== state.fingerprint) issues.push('报告对应的产品源码已变化');
  if (!report.runtime?.version || !semver.satisfies(report.runtime.version, current.peer)) issues.push('运行时不在当前兼容声明中');
  if (!semver.satisfies(report.runtime?.acpVersion || '', current.peer)) issues.push('实际 ACP 缺失或不在依赖声明中');
  for (const name of REQUIRED) {
    const stages = report.stages?.filter((stage) => stage.name === name) || [];
    if (stages.length !== 1 || stages[0].status !== 'passed') issues.push(`必测 ${name} 缺失、重复或未通过`);
  }
  return issues;
}
function releaseCheck(options) {
  const current = versions();
  const issues = [];
  const folder = runDir('release-check');
  const checks = [];
  if (typeof options.report !== 'string') issues.push('需要 --report 指定真实内核报告');
  else issues.push(...validateReport(json(path.resolve(options.report)), current));
  const matrix = json(path.join(ROOT, 'compat/versions.json'));
  for (const entry of matrix.versions) {
    if (entry.status !== 'passed' || !entry.evidence?.length) { issues.push(`${entry.dsh}/${entry.distribution} 没有通过证据`); continue; }
    const evidence = json(path.resolve(ROOT, entry.evidence[0]));
    if (evidence.runtime?.version !== entry.dsh || evidence.runtime?.distribution !== entry.distribution) issues.push(`${entry.dsh} 证据发行方式或版本不匹配`);
    if (entry.door !== evidence.packages?.door || entry.panel !== evidence.packages?.panel || entry.acp !== evidence.runtime?.acpVersion) issues.push(`${entry.dsh} 矩阵与证据版本不一致`);
    issues.push(...validateReport(evidence, current).map((issue) => `${entry.dsh}: ${issue}`));
  }
  for (const [pkg, version] of [['dsh-door', current.door], ['vscode-extension', current.panel]]) {
    if (!fs.readFileSync(path.join(ROOT, 'packages', pkg, 'CHANGELOG.md'), 'utf8').includes(`## [${version}]`)) issues.push(`${pkg} 缺少当前更新说明`);
  }
  if (typeof options['local-report'] !== 'string') issues.push('需要 --local-report 指定本机发布验收记录');
  else {
    const report = json(path.resolve(options['local-report']));
    if (report.source?.fingerprint !== sourceState().fingerprint) issues.push('本机验收对应的源码已变化');
    if (report.packages?.door !== current.door || report.packages?.panel !== current.panel) issues.push('本机验收对应的插件版本已变化');
    if (report.checks?.some((check) => check.status !== 'passed')) issues.push('本机验收仍存在失败或跳过');
    for (const name of LOCAL) if (!report.checks?.some((check) => check.name === name && check.status === 'passed' && check.evidence)) issues.push(`本机必测 ${name} 缺失或未通过`);
    for (const kind of ['tgz', 'vsix']) if (!report.artifacts?.some((item) => item.kind === kind)) issues.push(`缺少最终 ${kind} 安装包`);
    for (const artifact of report.artifacts || []) {
      const file = path.resolve(ROOT, artifact.file);
      if (!fs.existsSync(file) || sha256(file) !== artifact.sha256) issues.push(`安装包摘要不一致：${artifact.file}`);
    }
    const tgz = report.artifacts?.find((item) => item.kind === 'tgz');
    if (typeof options.report === 'string' && tgz && !json(path.resolve(options.report)).artifacts?.some((item) => item.kind === 'tgz' && item.sha256 === tgz.sha256)) issues.push('最终 tgz 与内核实际验收的安装包不同');
    const vsix = report.artifacts?.find((item) => item.kind === 'vsix');
    const editor = report.checks?.find((item) => item.name === 'vsix-editor')?.evidence;
    if (editor?.paths?.length !== 2 || !['attach', 'self'].every((mode) => editor.paths.filter((item) => item.mode === mode && item.exitCode === 0 && item.vsixSha256 === vsix?.sha256).length === 1)) issues.push('最终 VSIX 缺少匹配的双路径编辑器验收');
    for (const item of editor?.paths || []) {
      const file = path.resolve(ROOT, item.log || '');
      if (!item.log || !fs.existsSync(file) || sha256(file) !== item.logSha256) issues.push('编辑器验收日志缺失或摘要不同');
    }
  }
  // 发布门槛自身复核快速套件、界面和契约，避免只提交内核通过报告。
  for (const [name, argv] of [['quick-ui', ['packages/vscode-extension/test/run-all.js', '--ui', '--strict']], ['contracts', ['tools/compat/contracts.cjs']]]) {
    const result = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    const log = path.join(folder, `${name}.log`);
    fs.writeFileSync(log, redact(`${result.stdout || ''}${result.stderr || ''}`));
    checks.push({ name, status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, log: path.relative(ROOT, log).replace(/\\/g, '/'), logSha256: sha256(log) });
    if (result.status !== 0) issues.push(`${name} 必测失败或环境不满足`);
  }
  const result = { schemaVersion: 1, time: new Date().toISOString(), source: sourceState(), packages: current,
    status: issues.length ? 'failed' : 'passed', issues, checks };
  const file = writeReport(folder, result);
  console.log(JSON.stringify(result, null, 2)); console.log(`报告：${file}`);
  return result;
}
if (require.main === module) {
  try { process.exitCode = releaseCheck(argsOf()).status === 'passed' ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateReport, releaseCheck, REQUIRED, LOCAL };
