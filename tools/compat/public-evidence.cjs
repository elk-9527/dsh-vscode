'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 公开验证结果仅保留版本、摘要与检查状态，完整运行资料保留在本机。 */
function publicEvidence(report) {
  const clean = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : undefined;
  const version = value => clean(value, /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
  const status = value => clean(value, /^(?:passed|failed|partial|pending|skipped|not-applicable|unavailable|environment-blocked|acquisition-failed)$/);
  const digest = value => clean(value, /^[a-f0-9]{64}$/);
  const snapshot = value => value && ({ commit: clean(value.commit, /^[a-f0-9]{40}$/), fingerprint: digest(value.fingerprint), toolFingerprint: digest(value.toolFingerprint), lockFingerprint: digest(value.lockFingerprint) });
  const source = report.source || {}, runtime = report.runtime || {};
  return { schemaVersion: report.schemaVersion === 2 ? 2 : 1, status: status(report.status),
    platform: clean(report.platform, /^(?:win32|linux|darwin)$/),
    source: snapshot(source),
    ...(report.schemaVersion === 2 ? { sourceStart: snapshot(report.sourceStart), sourceEnd: snapshot(report.sourceEnd) } : {}),
    packages: { panel: version(report.packages?.panel), door: version(report.packages?.door), sdk: version(report.packages?.sdk) },
    runtime: { version: version(runtime.version), acpVersion: version(runtime.acpVersion), distribution: clean(runtime.distribution, /^(?:desktop|npm)$/) },
    stages: (Array.isArray(report.stages) ? report.stages : []).map(stage => ({ name: clean(stage.name, /^[a-z][a-z0-9-]{0,63}$/), status: status(stage.status), ...(typeof stage.required === 'boolean' ? { required: stage.required } : {}) })).filter(stage => stage.name && stage.status),
    checks: (Array.isArray(report.checks) ? report.checks : []).map(check => ({ name: clean(check.name, /^[a-z][a-z0-9 -]{0,95}$/), status: status(check.status) })).filter(check => check.name && check.status),
    artifacts: (Array.isArray(report.artifacts) ? report.artifacts : []).map(item => ({ kind: clean(item.kind, /^(?:tgz|vsix|sdk|pilot)$/), sha256: digest(item.sha256) })).filter(item => item.kind && item.sha256),
  };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('用法：node tools/compat/public-evidence.cjs <报告> <公开结果>');
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(publicEvidence(JSON.parse(fs.readFileSync(input, 'utf8'))), null, 2) + '\n');
}
module.exports = { publicEvidence };
