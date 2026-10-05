'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ROOT, argsOf, json, versions, candidates, resolveRuntime, sourceState, safeObject, semver } = require('./lib.cjs');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');

async function doctor(options = {}) {
  const source = versions();
  const inventory = candidates();
  const findings = [];
  let runtime;
  try { runtime = resolveRuntime(options); }
  catch (error) { findings.push({ kind: 'unavailable', message: error.message }); }
  if (runtime && !semver.satisfies(runtime.version, source.peer)) findings.push({ kind: 'peer-mismatch', message: `源码范围 ${source.peer} 排除了运行时 ${runtime.version}` });
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = ['desktop', 'vscode-panel'].map((name) => {
    const manifest = path.join(home, 'profiles', name, 'node_modules/dsh-acp-door/package.json');
    if (!fs.existsSync(manifest)) { findings.push({ kind: 'missing-plugin', profile: name, message: '接入点未安装' }); return { name, installed: false }; }
    const pkg = json(manifest);
    const peer = pkg.peerDependencies?.['@deepseek-ai/dsh-acp'];
    const compatible = Boolean(runtime && peer && semver.satisfies(runtime.version, peer));
    if (runtime && !compatible) findings.push({ kind: 'installed-peer-mismatch', profile: name, message: `已安装 ${pkg.version} 的范围 ${peer || '缺失'} 排除了 ${runtime.version}` });
    if (pkg.version !== source.door) findings.push({ kind: 'installed-version-drift', profile: name, message: `已安装 ${pkg.version}，源码 ${source.door}` });
    const directory = path.dirname(path.dirname(path.dirname(manifest)));
    const config = json(path.join(directory, 'package.json'));
    const enabled = Boolean(config.dsh?.profile?.bundles?.includes('dsh-acp-door'));
    const patchFile = path.join(directory, 'cordis.patch.yml');
    const patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
    const disabled = /(?:^- id: acp-door\s*\r?\n)(?:(?!^-)[\s\S])*?^[ \t]+disabled: true\s*$/m.test(patch);
    if (!enabled || disabled) findings.push({ kind: 'plugin-disabled', profile: name, message: '接入点未启用或被 patch 禁用' });
    return { name, installed: true, version: pkg.version, peer, compatible, enabled, disabled };
  });
  const extensionsRoot = path.join(os.homedir(), '.vscode/extensions');
  const installedPanels = fs.existsSync(extensionsRoot) ? fs.readdirSync(extensionsRoot)
    .filter((name) => /^elk-ydy\.dsh-acp-panel-/i.test(name))
    .map((name) => ({ version: json(path.join(extensionsRoot, name, 'package.json')).version })) : [];
  if (!installedPanels.some((item) => item.version === source.panel)) findings.push({ kind: 'panel-version-drift', message: `面板 ${source.panel} 尚未安装` });
  const endpoints = [];
  for (const port of [47821, 47831]) {
    const client = new DoorClient({ host: '127.0.0.1', port });
    try { await client.connect({ timeoutMs: 500, initializeTimeoutMs: 1500 }); endpoints.push({ port, connected: true, status: await client.doorStatus() }); }
    catch (error) { endpoints.push({ port, connected: false, error: error.message }); }
    finally { client.close(); }
  }
  return safeObject({ schemaVersion: 1, time: new Date().toISOString(), source: sourceState(), node: process.version,
    packages: source, inventory, runtime, profiles, installedPanels, endpoints, findings,
    status: findings.length ? 'failed' : 'passed' });
}
if (require.main === module) doctor(argsOf()).then((report) => {
  if (argsOf().json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`DSH ${report.runtime?.version || '未发现'} (${report.runtime?.distribution || '未知发行方式'})；源码接入点 ${report.packages.door} / 面板 ${report.packages.panel}`);
    for (const profile of report.profiles) console.log(`${profile.name}: ${profile.version || '未安装'}，兼容声明${profile.compatible ? '匹配' : '不匹配或未验证'}`);
    for (const endpoint of report.endpoints) console.log(`127.0.0.1:${endpoint.port}: ${endpoint.connected ? `已连接 ${endpoint.status.version}` : '未连接'}`);
    for (const finding of report.findings) console.log(`${finding.kind}: ${finding.message}`);
    console.log(`诊断：${report.status}`);
  }
  process.exitCode = report.status === 'passed' ? 0 : 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { doctor };
