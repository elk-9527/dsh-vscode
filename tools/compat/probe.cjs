'use strict';
const fs = require('node:fs'), path = require('node:path');
const { ROOT, argsOf, json, versions, sha256, semver, redact } = require('./lib.cjs');
const { REQUIRED, FINGERPRINTS } = require('./release-check.cjs');
const BEFORE_INSTALL = ['package', 'loopback-environment', 'runtime'];
const declaredVersion = dsh => json(path.join(ROOT, 'compat/versions.json')).versions.some(item => item.dsh === semver.valid(dsh) && item.distribution === 'npm');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const range = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

/** Only the complete, known gate message and its installer output can exempt a failed probe. */
function declarationRejection(error, report) {
  if (typeof error !== 'string') return false;
  const { door, peer } = report.packages, dsh = report.runtime.version;
  if (semver.satisfies(report.runtime.acpVersion, peer)) return false;
  let valid = true, count = 0;
  let rest = error.replace(/\r\n/g, '\n').replace(/^\s*\[WARN\]\s*/gm, '');
  const message = /Plugin ([^\s]+) is incompatible with dsh ([^\s:]+):\s*(?:peerDependencies|requirements)\s*(\{[^{}]*\})\.\s+Running it may cause crashes or data loss\.\s+Update the plugin or install a plugin version compatible with this dsh runtime\.\s+To accept this risk explicitly, grant the exact-version exemption for ([^\s]+) on dsh ([^\s]+) with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh\.\s+Exact-version exemption: not active\./g;
  rest = rest.replace(message, (_all, plugin, runtime, requirements, exemptionPlugin, exemptionRuntime) => {
    count++;
    try {
      const peers = JSON.parse(requirements);
      valid &&= plugin === `dsh-acp-door@${door}` && runtime === dsh && exemptionPlugin === plugin && exemptionRuntime === dsh
        && Object.keys(peers).length === 1 && range(peers['@deepseek-ai/dsh-acp']) === range(peer);
    } catch { valid = false; }
    return '';
  });
  // Unknown output remains a failure, including another plugin, a truncated message or an extra error.
  const prefix = redact(`${report.runtime.command} plugin --profile compat add file:${path.resolve(ROOT, report.artifacts[0].file).replace(/\\/g, '/')} 失败：`);
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  const harmless = [
    /^dsh: installation rejected:\s*$/,
    /^Progress: resolved \d+, reused \d+, downloaded \d+, added \d+(?:, done)?$/,
    /^Packages: \+\d+$/, /^\++$/,
    /^Packages are hard linked from the content-addressable store to the virtual store\.$/,
    /^(?:Content-addressable store|Virtual store) is at:\s+.+$/,
    /^Issues with peer dependencies found\. Run "pnpm peers check" to list them\.$/,
    /^dependencies:$/, /^Done in [\d.]+(?:ms|s) using pnpm v[\d.]+$/,
    /^! Corepack is about to download https:\/\/registry\.npmjs\.org\/pnpm\/-\/pnpm-[\d.]+\.tgz$/,
    /^dsh: restored package\.json, pnpm-lock\.yaml, and node_modules\.$/,
    /^dsh: plugin command failed; diagnostics: [^\n]+[/\\]pnpm\.log$/,
  ];
  const dependency = `+ dsh-acp-door ${door}`;
  const accept = `dsh: to accept the risk, run: dsh plugin --profile compat allow-version dsh-acp-door@${door} --dsh-version ${dsh} --accept-risk`;
  return valid && count > 0 && rest.split('\n').every(line => !line.trim() || line.trim() === dependency || line.trim() === accept || harmless.some(pattern => pattern.test(line.trim())));
}

function completeInputs(report, expected) {
  if (report?.schemaVersion !== 2 || !['win32', 'linux', 'darwin'].includes(report.platform)) return false;
  const current = expected.packages || versions(), requested = expected.dsh || report.requested;
  if (!semver.valid(requested) || report.requested !== requested || report.runtime?.version !== requested || report.runtime.distribution !== 'npm' || !semver.valid(report.runtime.acpVersion)) return false;
  if (['panel', 'door', 'sdk', 'peer'].some(key => !current[key] || report.packages?.[key] !== current[key])) return false;
  if (!Number.isFinite(Date.parse(report.time)) || !Number.isFinite(Date.parse(report.finishedAt)) || Date.parse(report.finishedAt) < Date.parse(report.time)) return false;
  if (FINGERPRINTS.some(key => !digest(report.sourceStart?.[key]) || report.sourceStart[key] !== report.sourceEnd?.[key] || report.sourceStart[key] !== report.source?.[key])) return false;
  if (!/^[a-f0-9]{40}$/.test(report.sourceStart?.commit || '') || report.sourceStart.commit !== report.sourceEnd?.commit || report.sourceStart.commit !== report.source?.commit) return false;
  if (report.sourceChanged || report.cleanupError || report.resources?.status !== 'passed' || report.resources.abort || !Array.isArray(report.resources.errors) || report.resources.errors.length) return false;
  if (!Array.isArray(report.stages) || report.stages.some(stage => !stage || typeof stage.name !== 'string') || new Set(report.stages.map(stage => stage.name)).size !== report.stages.length) return false;
  if (report.checks && (!Array.isArray(report.checks) || report.checks.some(check => check?.status !== 'passed' || check.error))) return false;
  const artifact = report.artifacts?.[0];
  if (!Array.isArray(report.artifacts) || report.artifacts.length !== 1 || artifact?.kind !== 'tgz' || artifact.name !== 'dsh-acp-door' || artifact.version !== current.door || !digest(artifact.sha256) || typeof artifact.file !== 'string' || !artifact.file) return false;
  if (expected.tgzSha256 && artifact.sha256 !== expected.tgzSha256 || expected.tgzFile && path.resolve(ROOT, artifact.file) !== expected.tgzFile) return false;
  const evidence = name => report.stages.find(stage => stage.name === name)?.evidence;
  return evidence('package')?.sha256 === artifact.sha256 && evidence('runtime')?.version === requested
    && evidence('runtime')?.distribution === 'npm' && evidence('runtime')?.acpVersion === report.runtime.acpVersion;
}

function classifyProbe(report, declared = false, expected = {}) {
  if (declared || declaredVersion(expected.dsh || report?.requested)) throw new Error('Declared combinations belong to the required regression matrix');
  if (report?.status === 'acquisition-failed' || Array.isArray(report?.stages) && report.stages.some(stage => stage?.status === 'acquisition-failed')) return 'acquisition-failed';
  if (!completeInputs(report, expected)) return 'incompatible';
  const stages = report.stages, install = stages.find(stage => stage.name === 'installation');
  const names = [...REQUIRED, 'loopback-environment', 'text-generation'];
  const passed = stage => stage.status === 'passed' && !stage.error;
  if (report.status === 'passed' && !report.error && names.every(name => stages.some(stage => stage.name === name)) && stages.every(stage => names.includes(stage.name))
    && stages.every(stage => passed(stage) || stage.name === 'text-generation' && stage.required === false && stage.status === 'not-applicable' && !stage.error)
    && install.evidence?.installedVersion === report.packages.door
    && semver.satisfies(report.runtime.acpVersion, report.packages.peer)
    && stages.find(stage => stage.name === 'status').evidence?.version === report.packages.door
    && stages.find(stage => stage.name === 'status').evidence?.runtime?.acpVersion === report.runtime.acpVersion) return 'candidate-passed';
  if (report.status !== 'failed' || stages.length !== BEFORE_INSTALL.length + 1 || !BEFORE_INSTALL.every((name, index) => stages[index].name === name && passed(stages[index]))
    || install !== stages.at(-1) || install.status !== 'failed' || report.error !== install.error) return 'incompatible';
  return declarationRejection(install.error, report) ? 'not-declared' : 'incompatible';
}

async function run(options) {
  const folder = path.join(ROOT, 'build/probes'), output = path.join(folder, 'probe-result.json');
  fs.mkdirSync(folder, { recursive: true }); fs.rmSync(output, { force: true });
  if (declaredVersion(options.dsh)) throw new Error('Use the supported regression job for this version');
  const expected = { dsh: options.dsh, packages: versions(), tgzSha256: sha256(options.tgz), tgzFile: path.resolve(options.tgz) };
  const report = await require('./test.cjs').run({ ...options, install: true });
  let stable = false;
  try { stable = sha256(options.tgz) === expected.tgzSha256; } catch { /* Missing candidates remain failed. */ }
  const status = stable ? classifyProbe(report, false, expected) : 'incompatible';
  const behavior = status === 'candidate-passed' ? 'passed' : status === 'not-declared' ? 'not-run' : 'not-validated';
  const explanation = status === 'not-declared' ? 'Installation declaration gate rejected the plugin; compatibility behavior was not run.'
    : status === 'candidate-passed' ? 'Compatibility behavior passed for this candidate.' : 'Compatibility behavior was not validated; the probe failed.';
  const publicInput = { ...report };
  for (const key of ['stages', 'checks', 'artifacts']) publicInput[key] = Array.isArray(report?.[key]) ? report[key].filter(item => item && typeof item === 'object') : [];
  const evidence = require('./public-evidence.cjs').publicEvidence(publicInput);
  const result = { ...evidence, dsh: semver.valid(options.dsh) || undefined, distribution: 'npm', status, behavior, declaredSupported: false,
    summary: `Candidate ${semver.valid(options.dsh) || 'unknown'}: ${status}. ${explanation} Declared support is unchanged.` };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(result.summary);
  return result;
}
if (require.main === module) run(argsOf()).then(result => { process.exitCode = ['candidate-passed', 'not-declared'].includes(result.status) ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { classifyProbe };
