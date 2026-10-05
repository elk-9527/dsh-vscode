'use strict';
/** 显式安装候选包；先备份清单、配置、旧安装包和当前扩展，不终止用户进程。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ROOT, argsOf, json, versions, resolveRuntime, locate, sha256, sourceState, safeObject } = require('./lib.cjs');

/** pnpm 使用同包名的首条规则；将原有精确版本合为一条，保持既有允许集合。 */
function mergeExclusions(values) {
  const rules = new Map();
  for (const value of values) {
    const at = value.indexOf('@', value.startsWith('@') ? 1 : 0);
    const name = at < 0 ? value : value.slice(0, at);
    const versions = at < 0 ? null : value.slice(at + 1).split('||').map((item) => item.trim());
    if (versions && versions.some((item) => !require('./lib.cjs').semver.valid(item))) throw new Error(`豁免只允许既有精确版本：${value}`);
    if (!rules.has(name)) rules.set(name, versions);
    else if (!versions || !rules.get(name)) rules.set(name, null);
    else rules.set(name, [...new Set([...rules.get(name), ...versions])]);
  }
  return [...rules].map(([name, versions]) => versions ? `${name}@${versions.join(' || ')}` : name);
}

function install(options) {
  if (!options.yes) throw new Error('需要 --yes 显式执行本机安装');
  const tgz = path.resolve(options.tgz || path.join(ROOT, `build/dsh-acp-door-${versions().door}.tgz`));
  const vsix = path.resolve(options.vsix || path.join(ROOT, `packages/vscode-extension/build/dsh-acp-panel-${versions().panel}.vsix`));
  for (const file of [tgz, vsix]) if (!fs.existsSync(file)) throw new Error(`安装包不存在：${file}`);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  // 同号候选包可能重新构建。使用内容摘要区分 file: 来源，避免包管理器复用旧内容。
  const installTgz = path.join(ROOT, 'build/install', `dsh-acp-door-${versions().door}-${sha256(tgz).slice(0, 16)}.tgz`);
  fs.mkdirSync(path.dirname(installTgz), { recursive: true });
  if (!fs.existsSync(installTgz)) fs.copyFileSync(tgz, installTgz);
  if (sha256(installTgz) !== sha256(tgz)) throw new Error('持久安装包摘要不匹配');
  const pilots = options.pilots ? json(path.join(ROOT, 'build/ide-bridge/pilots/manifest.json')).map(item => {
    const source = path.join(ROOT, item.file);
    if (sha256(source) !== item.packageSha256) throw new Error('试点包摘要不匹配');
    const persistent = path.join(ROOT, 'build/install', `${path.basename(source, '.tgz')}-${item.packageSha256.slice(0,16)}.tgz`);
    if (!fs.existsSync(persistent)) fs.copyFileSync(source, persistent);
    if (sha256(persistent) !== item.packageSha256) throw new Error('持久试点包摘要不匹配');
    return { ...item, persistent };
  }) : [];
  let sdkArchive;
  if (pilots.length) {
    const source = require('../bridge/packages.cjs').packSdk(path.join(ROOT, 'build'));
    sdkArchive = path.join(ROOT, 'build/install', `${path.basename(source, '.tgz')}-${sha256(source).slice(0, 16)}.tgz`);
    if (!fs.existsSync(sdkArchive)) fs.copyFileSync(source, sdkArchive);
    if (sha256(source) !== sha256(sdkArchive)) throw new Error('SDK 安装包摘要不匹配');
  }
  const runtime = resolveRuntime({ dsh: options.dsh || '0.2.0-rc.2', command: options.command });
  const backup = path.join(ROOT, 'backup', `compat-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backup, { recursive: true });
  const record = { time: new Date().toISOString(), source: sourceState(), packages: versions(), backup: path.relative(ROOT, backup), originals: [], operations: [],
    artifacts: [{ kind: 'tgz', file: path.relative(ROOT, tgz).replace(/\\/g, '/'), sha256: sha256(tgz) }, { kind: 'vsix', file: path.relative(ROOT, vsix).replace(/\\/g, '/'), sha256: sha256(vsix) }] };
  record.artifacts.push(...pilots.map(item => ({ kind: 'pilot', name: item.name, version: item.candidate, file: item.file, sha256: item.packageSha256 })));
  if (sdkArchive) record.artifacts.push({ kind: 'tgz', name: 'dsh-ide-bridge-sdk', version: versions().sdk, file: path.relative(ROOT, sdkArchive), sha256: sha256(sdkArchive) });
  for (const profile of ['desktop', 'vscode-panel']) {
    const directory = path.join(home, 'profiles', profile);
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
      const source = path.join(directory, name);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(backup, profile, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
      record.originals.push({ profile, name, sha256: sha256(source) });
    }
    const pkg = json(path.join(directory, 'package.json'));
    const installed = path.join(directory, 'node_modules/dsh-acp-door');
    if (fs.existsSync(installed)) fs.cpSync(installed, path.join(backup, profile, 'dsh-acp-door'), { recursive: true });
    if (sdkArchive && fs.existsSync(path.join(directory, 'node_modules/dsh-ide-bridge-sdk'))) fs.cpSync(path.join(directory, 'node_modules/dsh-ide-bridge-sdk'), path.join(backup, profile, 'dsh-ide-bridge-sdk'), { recursive: true });
    for (const pilot of pilots) {
      const original = path.join(directory, 'node_modules', pilot.name);
      if (fs.existsSync(original)) fs.cpSync(original, path.join(backup, profile, 'pilots', pilot.key), { recursive: true });
    }
    const old = String(pkg.dependencies?.['dsh-acp-door'] || '').replace(/^file:/, '');
    if (old.endsWith('.tgz') && fs.existsSync(old)) fs.copyFileSync(old, path.join(backup, path.basename(old)));
  }
  const extensions = path.join(os.homedir(), '.vscode/extensions');
  for (const entry of fs.readdirSync(extensions).filter((name) => /^elk-ydy\.dsh-acp-panel-/i.test(name))) {
    fs.cpSync(path.join(extensions, entry), path.join(backup, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify(safeObject(record), null, 2));
  try {
    for (const profile of ['desktop', 'vscode-panel']) {
      const directory = path.join(home, 'profiles', profile);
      const sdkPolicy = sdkArchive && require('../bridge/packages.cjs').pinSdk(directory, sdkArchive);
      const extra = [];
      if (options['offline-exemption']) {
        if (options['offline-exemption'] !== 'billion-context@0.1.175') throw new Error('此安装器只支持固定离线豁免 billion-context@0.1.175');
        // 保留原有精确豁免，只在命令行增补已校验的固定版本，不改 workspace 或全局策略。
        const text = fs.readFileSync(path.join(directory, 'pnpm-workspace.yaml'), 'utf8');
        const block = text.match(/^minimumReleaseAgeExclude:\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/m)?.[1] || '';
        const exclusions = block.split(/\r?\n/).filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, '').trim().replace(/^(['"])(.*)\1$/, '$2'));
        extra.push('--offline', ...mergeExclusions([...exclusions, options['offline-exemption']]).map((spec) => `--config.minimum-release-age-exclude=${spec}`));
        record.exemption = { version: options['offline-exemption'], offline: true, persisted: false };
      }
      locate.runDshSync({ command: runtime.command, args: ['plugin', '--profile', profile, 'add', ...[installTgz,...(sdkArchive ? [sdkArchive] : []),...pilots.map(item=>item.persistent)].map(file=>`file:${file.replace(/\\/g, '/')}`), ...extra], timeoutMs: 180000 });
      const installed = json(path.join(home, 'profiles', profile, 'node_modules/dsh-acp-door/package.json'));
      if (installed.version !== versions().door) throw new Error(`${profile} 安装版本不匹配`);
      const files = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];
      const walk = (base, prefix) => {
        for (const name of fs.readdirSync(base)) {
          const rel = path.join(prefix, name), file = path.join(base, name);
          if (fs.statSync(file).isDirectory()) walk(file, rel); else files.push(rel);
        }
      };
      walk(path.join(ROOT, 'packages/dsh-door/lib'), 'lib');
      for (const file of files) if (sha256(path.join(ROOT, 'packages/dsh-door', file)) !== sha256(path.join(directory, 'node_modules/dsh-acp-door', file))) throw new Error(`${profile} 的装机文件与源码不同：${file}`);
      const manifestFile = path.join(directory, 'package.json');
      const manifest = json(manifestFile);
      if (!manifest.dsh.profile.bundles.includes('dsh-acp-door')) {
        manifest.dsh.profile.bundles.push('dsh-acp-door');
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const patchFile = path.join(directory, 'cordis.patch.yml');
      const patch = fs.readFileSync(patchFile, 'utf8');
      const enabled = patch.replace(/(^- id: acp-door\s*\r?\n[ \t]+disabled:) true(?=\s*(?:\r?\n|$))/gm, '$1 false');
      if (enabled !== patch) {
        fs.writeFileSync(patchFile, enabled);
        record.operations.push({ profile, change: 'enable-acp-door', status: 'passed' });
      }
      const oldPolicy = path.join(backup, profile, 'pnpm-workspace.yaml');
      if (sdkPolicy ? fs.readFileSync(path.join(directory, 'pnpm-workspace.yaml'), 'utf8') !== sdkPolicy.updated : sha256(oldPolicy) !== sha256(path.join(directory, 'pnpm-workspace.yaml'))) throw new Error(`${profile} 的策略文件发生非预期变化`);
      if (sdkArchive) {
        const source = path.join(ROOT, 'packages/dsh-bridge-sdk'), target = path.join(directory, 'node_modules/dsh-ide-bridge-sdk');
        const compare = base => { for (const name of fs.readdirSync(path.join(source, base))) { const relative = path.join(base, name); if (fs.statSync(path.join(source, relative)).isDirectory()) compare(relative); else if (sha256(path.join(source, relative)) !== sha256(path.join(target, relative))) throw new Error('SDK 装机内容不匹配'); } };
        compare('lib'); for (const name of ['package.json', 'README.md', 'LICENSE']) if (sha256(path.join(source, name)) !== sha256(path.join(target, name))) throw new Error('SDK 发行元数据不匹配');
        record.operations.push({ profile, sdkVersion: versions().sdk, localSdkOverride: true, status: 'passed' });
      }
      for (const pilot of pilots) {
        const candidate = path.join(ROOT, 'build/ide-bridge/pilots', `${pilot.key}-${pilot.candidate}`);
        const target = path.join(directory, 'node_modules', pilot.name);
        if (json(path.join(target,'package.json')).version !== pilot.candidate) throw new Error('试点安装版本不匹配');
        const compare = base => {
          for (const name of fs.readdirSync(path.join(candidate,base))) {
            const relative = path.join(base,name);
            if (fs.statSync(path.join(candidate,relative)).isDirectory()) compare(relative);
            else if (sha256(path.join(candidate,relative)) !== sha256(path.join(target,relative))) throw new Error(`试点装机文件不匹配：${pilot.name}/${relative}`);
          }
        };
        // npm 打包会排除构建工具和 dotfiles；业务发行内容、清单和许可证逐字节核验。
        for (const name of ['lib','client']) if (fs.existsSync(path.join(candidate,name))) compare(name);
        for (const name of ['package.json','LICENSE','LICENSE.md','README.md']) if (fs.existsSync(path.join(candidate,name)) && sha256(path.join(candidate,name)) !== sha256(path.join(target,name))) throw new Error('试点发行元数据不匹配');
        record.operations.push({profile,pilot:pilot.name,version:pilot.candidate,status:'passed'});
      }
      record.operations.push({ profile, version: installed.version, filesCompared: files.length, installedArtifact: path.relative(ROOT, installTgz).replace(/\\/g, '/'), status: 'passed' });
    }
    locate.runDshSync({ command: options.code || 'code', args: ['--install-extension', vsix, '--force'], timeoutMs: 120000 });
    record.operations.push({ extension: 'Elk-ydy.dsh-acp-panel', version: versions().panel, status: 'passed' });
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
  finally { fs.writeFileSync(path.join(backup, 'record.json'), `${JSON.stringify(safeObject(record), null, 2)}\n`); console.log(`备份与安装记录：${backup}`); }
  return record;
}
if (require.main === module) { try { install(argsOf()); } catch (error) { console.error(require('./lib.cjs').redact(error.message)); process.exitCode = 1; } }
module.exports = { install, mergeExclusions };
