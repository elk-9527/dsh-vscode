'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { ROOT, json, sourceState, versions, sha256, argsOf } = require('./lib.cjs');
const CHECKS = ['extension activation', 'isolated observation loaded', 'native commands', 'runtime providers', 'one shared connection', 'isolated endpoint home', 'native configuration diagnosis', 'diagnosis clipboard', 'editor active theme 1', 'editor active theme 2', 'editor active theme 3', 'native keyboard changes tree selection', 'editor reduced motion configuration', 'Problems finding', 'native full report', 'run view', 'reference document is unsaved', 'native participant registered', 'native Chat receives unsaved file reference', 'native history pagination', 'native history search', 'native Markdown export', 'finding quick fix action', 'fix preview without source mutation', 'native diff preview', 'approved single fix stays unsaved', 'save and review uses new snapshot', 'stale diagnostics removed', 'explicit retry new identity', 'cleanup preserves newer findings', 'finished cleanup', 'window reopen restores review'];
CHECKS.push('native model configuration diagnosis', 'native draft persistence', 'window reopen restores draft');
CHECKS.push('native composer workspace file search', 'native composer unsaved file snapshot', 'native composer selection snapshot', 'native composer manual skill attachment');
CHECKS.push('native composer offline project skill search', 'native composer offline project skill body');
CHECKS.push('native composer Git diff snapshot', 'native composer Problems snapshot', 'native composer immutable context', 'native composer context queue', 'native composer context transmission');
CHECKS.push('native slash commands', 'native workflow baseline', 'native workflow diff', 'native workflow undo', 'native workflow undo conflict', 'native test task pass', 'native test task fail', 'native test result attachment', 'native test task cancellation');
CHECKS.push('native session switch blocks undo', 'native test blocks history switch', 'native test blocks session adoption', 'native model picker rechecks running task', 'native history clears workflow records');
CHECKS.splice(CHECKS.indexOf('cleanup preserves newer findings'), 2, 'cleanup preserves referenced case and newer findings', 'finished cleanup protects open evidence');
CHECKS.push('no editor completion commands', 'no editor completion payload', 'no code completion capability');
CHECKS.push('review baseline has no chat turn', 'real repair baseline test fails', 'independent repair test passes', 'repair and re-review share saved case', 'native durable case report', 'window reopen keeps complete saved report', 'offline saved repair and test history');
CHECKS.push('native file editor opens', 'composer captures opened editor');
function requiredChecks(editor, nativeChat, { historical = false } = {}) {
  const checks = nativeChat !== true && require('semver').valid(editor) && require('semver').lt(editor, '1.91.0')
    ? [...CHECKS.filter(name => !['native participant registered', 'native Chat receives unsaved file reference'].includes(name)), 'native Chat unavailable keeps sidebar', 'sidebar receives unsaved file reference']
    : [...CHECKS];
  return historical ? checks.map(name => name.replace(/^editor active theme /, 'native theme ').replace('native keyboard changes tree selection', 'native keyboard navigation commands').replace('editor reduced motion configuration', 'reduced motion setting')) : checks;
}
function editorEvidence(report, state = sourceState(), current = versions(), { supported = false, vsix, platform = process.platform } = {}) {
  assert.equal(report.status, 'passed', '编辑器报告未通过');
  const identityIssues = require('./release-check.cjs').validateIdentity(report, current, state, platform);
  assert.deepEqual(identityIssues, [], '编辑器报告的版本、平台或起止指纹无效');
  const stages = Array.isArray(report.stages) ? report.stages : [];
  const matches = stages.filter(stage => stage?.name === 'packed-vsix-native-editor');
  assert.equal(matches.length, 1, '需要唯一的原生编辑器验收阶段');
  assert.equal(matches[0].status, 'passed', '原生编辑器验收未通过');
  assert(!stages.some(stage => stage?.status !== 'passed' && !(stage?.required === false && stage.status === 'not-applicable')), '编辑器报告仍有失败或跳过');
  const editor = matches[0].result;
  const minimum = require('semver').minVersion(current.vscode || json(path.join(ROOT, 'packages/vscode-extension/package.json')).engines.vscode)?.version;
  if (supported) assert(require('semver').satisfies(editor?.vscode || '', `^${minimum}`), '编辑器版本不在声明支持范围');
  else assert.equal(editor?.vscode, minimum, '未使用声明的最低编辑器');
  assert(Array.isArray(editor.diagnosticLaunchFlags) && editor.diagnosticLaunchFlags.length === 0, '默认启动未通过');
  assert.notEqual(editor.nativeMode, 'restricted', '原生能力受到限制');
  assert(Array.isArray(editor.checks) && editor.checks.every(check => typeof check === 'string'), '编辑器检查必须是名称数组');
  const nativeChat = editor.checks.includes('native participant registered');
  const checks = requiredChecks(editor.vscode, nativeChat);
  for (const check of checks) assert(editor.checks.includes(check), `缺少编辑器检查：${check}`);
  const artifacts = report.artifacts?.filter(item => item.kind === 'vsix') || [];
  assert.equal(artifacts.length, 1, '需要唯一的实际验收 VSIX');
  const archive = path.resolve(ROOT, vsix || artifacts[0].file);
  assert.equal(editor.vsixSha256, artifacts[0].sha256, '编辑器与报告未使用同一候选');
  assert.equal(editor.vsixSha256, sha256(archive), '安装包已变化');
  return { schemaVersion: 2, status: 'passed', platform, editor: editor.vscode, defaultLaunch: true,
    source: report.sourceEnd, sourceStart: report.sourceStart, sourceEnd: report.sourceEnd, packages: { panel: current.panel, door: current.door, sdk: current.sdk },
    vsixSha256: editor.vsixSha256, capabilities: { nativeChat }, checks: checks.map(name => ({ name, status: 'passed' })) };
}
function writeEditorEvidence(input, output, options = {}, context = {}) {
  assert(input && output, '需要输入报告与公开输出文件');
  const file = path.resolve(output);
  assert(!fs.existsSync(file), '编辑器证据已存在；请指定新路径，保留原记录');
  const evidence = editorEvidence(json(path.resolve(input)), context.state, context.current, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  return evidence;
}
if (require.main === module) {
  try {
    const [input, output, ...argv] = process.argv.slice(2), options = argsOf(argv);
    writeEditorEvidence(input, output, { supported: options.supported === true, vsix: options.vsix });
    console.log('最低编辑器公开验证结果已写入');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { editorEvidence, writeEditorEvidence, CHECKS, requiredChecks };
