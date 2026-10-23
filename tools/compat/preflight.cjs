'use strict';
/** 显式执行本地预检，保存原始报告与两个输出流；正式发布仅重读并校验已有证据。 */
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, argsOf, sourceState, versions, redact, runDir, sha256 } = require('./lib.cjs');
const { FINGERPRINTS, PREFLIGHT_COMMANDS, preflightSummary } = require('./release-check.cjs');
async function runPreflight(options = {}) {
  const folder = runDir('preflight'), reports = {};
  const browser = require('../../packages/vscode-extension/tools/chrome.cjs').findChrome();
  const resources = require('../run-resources.cjs').createRunResources({ folder, label: 'work', keep: Boolean(options['keep-work']) });
  try {
    for (const [name, argv] of Object.entries(PREFLIGHT_COMMANDS)) {
      const sourceStart = sourceState(), stdout = path.join(folder, name + '.stdout.log'), stderr = path.join(folder, name + '.stderr.log');
      fs.writeFileSync(stdout, ''); fs.writeFileSync(stderr, '');
      let child, exitCode = null, error;
      try {
        await resources.guard(async () => {
          child = spawn(process.execPath, argv, { cwd: ROOT, env: resources.childEnv({ ...process.env, ...(browser ? { DSH_PANEL_CHROME: browser } : {}) }), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
          resources.child(child, name);
          child.stdout.on('data', chunk => resources.appendLog(stdout, chunk));
          child.stderr.on('data', chunk => resources.appendLog(stderr, chunk));
          exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        });
      } catch (failure) { error = redact(failure.message); }
      const sourceEnd = sourceState(), stable = FINGERPRINTS.every(key => sourceStart[key] === sourceEnd[key]);
      const summary = preflightSummary(name, fs.readFileSync(stdout, 'utf8'));
      const status = exitCode === 0 && stable && summary.complete && !error ? 'passed' : 'failed';
      reports[name] = { schemaVersion: 2, evidenceVersion: 1, platform: process.platform, packages: versions(), source: sourceEnd, sourceStart, sourceEnd, status,
        checks: [{ name, status, command: argv, exitCode, stable, summary, ...(error ? { error } : {}), logs: [stdout, stderr].map((file, index) => ({
          stream: index ? 'stderr' : 'stdout', file: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha256(file) })) }] };
      if (resources.signal.aborted) break;
    }
  } finally {
    const result = await resources.close();
    if (result.status !== 'passed' || result.abort) for (const report of Object.values(reports)) { report.status = 'failed'; report.resources = result; }
  }
  const file = options.out ? path.resolve(options.out) : path.join(folder, 'preflight.json');
  if (fs.existsSync(file)) throw new Error('Preflight report already exists');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(reports, null, 2) + '\n');
  console.log(file); return reports;
}
if (require.main === module) runPreflight(argsOf()).then(result => { process.exitCode = Object.keys(result).length === 2 && Object.values(result).every(report => report.status === 'passed') ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runPreflight };
