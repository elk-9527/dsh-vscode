'use strict';

/** Run every current suite and reject validation if the product changed mid-run. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, runDir, sourceState, versions, safeObject, redact, sha256 } = require('../compat/lib.cjs');
const { strictSummary, STRICT_COMMAND } = require('../compat/release-check.cjs');
const { freePort } = require('../compat/test.cjs');
const { desktopProfilePatchArgs } = require('../../packages/vscode-extension/src/door/setup');
const { resolveTestDshCommand } = require('../../packages/vscode-extension/test/helpers/door');

async function run() {
  const directory = runDir('full-regression'), logFile = path.join(directory, 'full-suite.log');
  const sourceStart = sourceState();
  const report = { schemaVersion: 2, platform: process.platform, time: new Date().toISOString(), source: sourceStart, sourceStart, packages: versions(), status: 'failed', command: STRICT_COMMAND };
  let child;
  try {
    const options = require('../compat/lib.cjs').argsOf();
    assert(process.env.DSH_HOME, '严格回归需要显式指定 build/ 下的专用 DSH_HOME');
    const home = path.resolve(process.env.DSH_HOME), build = path.join(ROOT, 'build');
    assert(home.startsWith(build + path.sep), '严格回归不能使用日常 DSH 配置');
    fs.mkdirSync(home, { recursive: true });
    assert(fs.realpathSync(home).startsWith(fs.realpathSync(build) + path.sep), '严格回归目录不能通过链接指向日常配置');
    const candidate = options.tgz ? require('./packages.cjs').verifyCandidate(options.tgz, 'tgz') : undefined;
    report.scope = candidate ? 'candidate-door-regression' : 'source-regression';
    report.artifacts = candidate ? [require('./packages.cjs').artifactRecord(candidate)] : [];
    const port = await freePort(), patch = desktopProfilePatchArgs({ profile: 'vscode-panel' })[1];
    report.port = port;
    const env = { ...process.env, DSH_PANEL_HOST: '127.0.0.1', DSH_PANEL_PROFILE: 'dshdoor', DSH_PANEL_PORT: String(port), DSH_PANEL_DSH: resolveTestDshCommand() };
    if (candidate) env.DSH_PANEL_TEST_DOOR_CANDIDATE = candidate.file;
    else delete env.DSH_PANEL_TEST_DOOR_CANDIDATE;
    if (!env.DSH_PANEL_TEST_PATCH && patch) env.DSH_PANEL_TEST_PATCH = patch;
    const log = fs.createWriteStream(logFile);
    child = spawn(process.execPath, ['test/run-all.js', '--all', '--strict'], {
      cwd: path.join(ROOT, 'packages/vscode-extension'), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    try { report.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { await new Promise(resolve => log.end(resolve)); }
    const output = fs.readFileSync(logFile, 'utf8');
    report.summary = strictSummary(output);
    report.suites = report.summary.suites || undefined;
    if (report.exitCode === 0 && report.summary.complete) report.status = 'passed';
  } catch (error) { report.error = redact(error.message); }
  finally {
    if (child && child.exitCode === null) child.kill();
    if (fs.existsSync(logFile)) report.log = { file: path.relative(ROOT, logFile).replace(/\\/g, '/'), sha256: sha256(logFile) };
    report.sourceEnd = sourceState();
    if (require('../compat/release-check.cjs').FINGERPRINTS.some(key => report.sourceStart[key] !== report.sourceEnd[key])) {
      report.status = 'failed'; report.sourceChanged = true;
      report.error ||= 'Product sources changed during strict regression; rerun on a stable checkout.';
    }
    report.source = report.sourceEnd;
    for (const artifact of report.artifacts || []) if (require('../compat/lib.cjs').sha256(path.resolve(ROOT, artifact.file)) !== artifact.sha256) { report.status = 'failed'; report.error = '候选包在回归期间发生变化'; }
    fs.writeFileSync(path.join(directory, 'regression-report.json'), JSON.stringify(safeObject(report), null, 2) + '\n');
    console.log(`Full strict regression: ${report.status}${report.suites ? ` (${report.suites} suites)` : ''}`);
    if (report.error) console.error(report.error);
    console.log(path.join(directory, 'regression-report.json'));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}

if (require.main === module) run();
