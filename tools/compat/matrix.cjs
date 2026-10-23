'use strict';
/** 仅显式登记通过报告；CI 的新候选检查不自动扩大支持范围。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, json, versions, sourceState } = require('./lib.cjs');
const { validateReport, releaseRequirements } = require('./release-check.cjs');
const { publicEvidence } = require('./public-evidence.cjs');

function updateMatrix(matrix, report, current, state, evidence, load) {
  const issues = validateReport(report, current, state, { platform: report.platform });
  if (issues.length) throw new Error(`不能登记通过：${issues.join('；')}`);
  matrix = structuredClone(matrix);
  if (!matrix.versions.some(item => item.dsh === report.runtime.version && item.distribution === report.runtime.distribution && (item.platform || matrix.platform) === report.platform)) throw new Error('新候选需要先在兼容矩阵中建立待验证条目');
  const tgzSha256 = report.artifacts.find(item => item.kind === 'tgz').sha256;
  let entry = matrix.versions.find(item => item.dsh === report.runtime.version && item.distribution === report.runtime.distribution && (item.platform || matrix.platform) === report.platform && item.panel === current.panel && item.door === current.door && item.sdk === current.sdk && item.fingerprint === state.fingerprint && item.toolFingerprint === state.toolFingerprint && item.lockFingerprint === state.lockFingerprint && item.tgzSha256 === tgzSha256);
  if (!entry) { entry = { dsh: report.runtime.version, distribution: report.runtime.distribution, platform: report.platform, panel: current.panel, door: current.door, sdk: current.sdk }; matrix.versions.push(entry); }
  Object.assign(entry, { status: 'passed', door: report.packages.door, panel: report.packages.panel,
    acp: report.runtime.acpVersion, testedAt: report.finishedAt, fingerprint: report.source.fingerprint, toolFingerprint: state.toolFingerprint, lockFingerprint: state.lockFingerprint, tgzSha256, evidence: [evidence] });
  const currentEntries = matrix.versions.filter(item => ['panel', 'door', 'sdk'].every(name => item[name] === current[name]));
  const candidates = [...new Set(currentEntries.flatMap(item => item.evidence || []))].map(file => ({ file, report: file === evidence ? report : load(file) }));
  const valid = candidates.filter(item => item.report && !validateReport(item.report, current, state, { platform: item.report.platform, tgzSha256 }).length);
  const files = valid.map(item => item.file), reports = valid.map(item => item.report);
  const complete = releaseRequirements(matrix, {}).combinations.every(combination => {
    const matches = reports.filter(item => item?.runtime?.version === combination.dsh && item.runtime.distribution === combination.distribution && item.platform === combination.platform);
    return matches.length === 1 && !validateReport(matches[0], current, state, { ...combination, tgzSha256 }).length;
  });
  matrix.currentRelease = { status: complete ? 'passed' : 'pending', panel: current.panel, door: current.door, sdk: current.sdk, evidence: files };
  return matrix;
}
function recordEvidence(file, { root = ROOT, current = versions(), state = sourceState(), platform = process.platform } = {}) {
  const report = json(path.resolve(file));
  const issues = validateReport(report, current, state, { platform });
  if (issues.length) throw new Error(`不能登记通过：${issues.join('；')}`);
  const matrixFile = path.join(root, 'compat/versions.json');
  const identity = crypto.createHash('sha256').update(JSON.stringify({ packages: [current.panel, current.door, current.sdk], runtime: report.runtime, platform: report.platform,
    inputs: [state.fingerprint, state.toolFingerprint, state.lockFingerprint], tgz: report.artifacts.find(item => item.kind === 'tgz').sha256 })).digest('hex').slice(0, 24);
  const evidence = `compat/evidence/public-dsh-${report.runtime.version}-${report.runtime.distribution}-${report.platform}-door-${current.door}-panel-${current.panel}-sdk-${current.sdk}-${identity}.json`;
  const destination = path.join(root, evidence);
  if (fs.existsSync(destination)) {
    const previous = json(destination);
    const existingIssues = validateReport(previous, current, state, { platform, dsh: report.runtime.version, distribution: report.runtime.distribution, tgzSha256: report.artifacts.find(item => item.kind === 'tgz').sha256 });
    if (existingIssues.length || previous.runtime.acpVersion !== report.runtime.acpVersion) throw new Error('已有证据与当前身份不同；保留原文件并拒绝登记');
  }
  const matrix = updateMatrix(json(matrixFile), report, current, state, evidence, name => {
    try { return json(path.join(root, name)); } catch { return undefined; }
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, `${JSON.stringify(publicEvidence(report), null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(matrixFile, `${JSON.stringify(matrix, null, 2)}\n`);
  return evidence;
}
module.exports = { recordEvidence, updateMatrix };
