'use strict';

/** Run every current suite and reject validation if the product changed mid-run. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, runDir, sourceState, versions, safeObject, redact } = require('../compat/lib.cjs');
const { freePort } = require('../compat/test.cjs');
const { desktopProfilePatchArgs } = require('../../packages/vscode-extension/src/door/setup');
const { resolveTestDshCommand } = require('../../packages/vscode-extension/test/helpers/door');

async function run() {
  const directory = runDir('full-regression'), logFile = path.join(directory, 'full-suite.log');
  const report = { time: new Date().toISOString(), source: sourceState(), packages: versions(), status: 'failed', command: 'node test/run-all.js --all --strict' };
  let child;
  try {
    const port = await freePort(), patch = desktopProfilePatchArgs({ profile: 'vscode-panel' })[1];
    report.port = port;
    const env = { ...process.env, DSH_PANEL_HOST: '127.0.0.1', DSH_PANEL_PROFILE: 'dshdoor', DSH_PANEL_PORT: String(port), DSH_PANEL_DSH: resolveTestDshCommand() };
    if (!env.DSH_PANEL_TEST_PATCH && patch) env.DSH_PANEL_TEST_PATCH = patch;
    const log = fs.createWriteStream(logFile);
    child = spawn(process.execPath, ['test/run-all.js', '--all', '--strict'], {
      cwd: path.join(ROOT, 'packages/vscode-extension'), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    try { report.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { await new Promise(resolve => log.end(resolve)); }
    const output = fs.readFileSync(logFile, 'utf8');
    report.suites = Number(/全部套件通过（共\s*(\d+)\s*个）/.exec(output)?.[1]) || undefined;
    if (report.exitCode === 0 && report.suites) report.status = 'passed';
  } catch (error) { report.error = redact(error.message); }
  finally {
    if (child && child.exitCode === null) child.kill();
    report.sourceEnd = sourceState();
    if (report.source.fingerprint !== report.sourceEnd.fingerprint) {
      report.status = 'failed'; report.sourceChanged = true;
      report.error ||= 'Product sources changed during strict regression; rerun on a stable checkout.';
    }
    fs.writeFileSync(path.join(directory, 'regression-report.json'), JSON.stringify(safeObject(report), null, 2) + '\n');
    console.log(`Full strict regression: ${report.status}${report.suites ? ` (${report.suites} suites)` : ''}`);
    if (report.error) console.error(report.error);
    console.log(path.join(directory, 'regression-report.json'));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}

if (require.main === module) run();
