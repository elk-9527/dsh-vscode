'use strict';

/** Prepare or repair the command-line profile used by the VS Code panel. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDshSync } = require('./locate');
const { resolveSessionsRoot } = require('../dsh/sessions');

const SAFE_PROFILE = /^[A-Za-z0-9._-]+$/;

function profileDirectory(profile, { homedir = os.homedir(), env = process.env } = {}) {
  const home = path.dirname(resolveSessionsRoot({ homedir, env }));
  return path.join(home, 'profiles', profile);
}

function inspectPanelProfile(profile, options = {}) {
  const directory = profileDirectory(profile, options);
  const manifest = path.join(directory, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return {
      exists: false,
      directory,
      bundles: [],
      dependencies: {},
      hasDoor: false,
      hasWebApp: false,
    };
  }
  const raw = pkg?.dsh?.profile?.bundles;
  const bundles = Array.isArray(raw) ? raw.map(String) : [];
  const dependencies =
    pkg?.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
      ? Object.fromEntries(
          Object.entries(pkg.dependencies).map(([name, spec]) => [String(name), String(spec)]),
        )
      : {};
  return {
    exists: true,
    directory,
    bundles,
    dependencies,
    hasDoor: bundles.some((name) => /(^|\/)dsh-acp-door(?:$|@)/.test(name)),
    hasWebApp: bundles.some((name) => /@deepseek-ai\/dsh-web-app/.test(name)),
  };
}

/** 连接组件由 preparePanelProfile 单独维护，不能被 desktop 中的本地开发来源覆盖。 */
function isDoorPackage(name) {
  return name === 'dsh-acp-door' || name.endsWith('/dsh-acp-door');
}

/**
 * 只有注册表依赖可以在另一个配置集中无歧义地重建。
 *
 * `file:` / `link:` / Git / URL 依赖通常只在原配置集的安装现场有效；静默复制它们可能
 * 指向已删除的临时包，甚至把开发目录带进生产配置。因此这些来源只报告、不自动安装。
 */
function isPortableRegistrySpec(spec) {
  const value = String(spec || '').trim();
  if (!value) return false;
  return !/^(?:(?:file|link|workspace|catalog|git|github|gitlab|bitbucket|https?|ssh):|[A-Za-z]:[\\/]|\.{0,2}[\\/]|[\\/])/i.test(value);
}

/** 读取源配置集中实际装入的版本；优先于 package.json 中可能带范围的声明。 */
function installedVersion(state, name) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(state.directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
    );
    if (pkg?.name === name && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // 缺少 node_modules 或包清单损坏：由调用方回退到声明中的精确版本。
  }
  return undefined;
}

/** 标准 npm 版本号；同步时固定到源配置集的实际版本，不把范围继续扩散到目标配置集。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 计算 desktop → 面板自启配置集的插件差异，不执行任何命令。
 *
 * 只同步同时出现在 `dependencies` 与 `dsh.profile.bundles` 中的直接插件：前者给出来源，
 * 后者证明该包当前确实启用。DSH 自带的基础 bundle 不在 dependencies 中，因而不会被误装。
 */
function planPanelPluginSync({
  profile = 'vscode-panel',
  sourceProfile = 'desktop',
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  const source = inspectPanelProfile(sourceProfile, { homedir, env });
  const target = inspectPanelProfile(profile, { homedir, env });
  const active = new Set(source.bundles);
  const install = [];
  const skipped = [];

  if (!source.exists || !target.exists) {
    return { source, target, install, skipped };
  }

  for (const [name, declared] of Object.entries(source.dependencies)) {
    if (!active.has(name) || isDoorPackage(name)) continue;
    if (!isPortableRegistrySpec(declared)) {
      skipped.push({ name, spec: declared, reason: 'non-registry-source' });
      continue;
    }
    const version = installedVersion(source, name)
      || (EXACT_VERSION.test(declared) ? declared : undefined);
    if (!version || !EXACT_VERSION.test(version)) {
      skipped.push({ name, spec: declared, reason: 'unresolved-version' });
      continue;
    }
    const alreadyEnabled = target.bundles.includes(name);
    const currentVersion = installedVersion(target, name)
      || (EXACT_VERSION.test(target.dependencies[name] || '') ? target.dependencies[name] : undefined);
    if (alreadyEnabled && currentVersion === version) continue;
    install.push({ name, version, argument: `${name}@${version}` });
  }

  return { source, target, install, skipped };
}

/**
 * 将桌面端已经启用的注册表插件按实际版本补到面板自启配置集。
 * 不删除目标配置集的独有插件，也不写 desktop。
 */
function syncPanelProfilePlugins({
  command,
  profile = 'vscode-panel',
  sourceProfile = 'desktop',
  run = runDshSync,
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  if (!SAFE_PROFILE.test(String(profile || '')) || !SAFE_PROFILE.test(String(sourceProfile || ''))) {
    throw new Error('插件同步使用的配置集名称不合法。');
  }
  if (profile === sourceProfile) {
    return { install: [], skipped: [], synced: [], unchanged: true };
  }

  const plan = planPanelPluginSync({ profile, sourceProfile, homedir, env });
  if (!plan.source.exists || !plan.target.exists || plan.install.length === 0) {
    return { ...plan, synced: [], unchanged: plan.install.length === 0 };
  }
  if (!plan.target.hasWebApp) {
    throw new Error(`配置集 ${profile} 不是可由面板自启的 web 配置集；未同步桌面端插件。`);
  }
  if (!String(command || '').trim()) throw new Error('没有可用的 DSH 命令。');

  run({
    command,
    args: [
      'plugin',
      '--profile',
      profile,
      'add',
      ...plan.install.map((item) => item.argument),
    ],
    timeoutMs: 180000,
  });

  const finalState = inspectPanelProfile(profile, { homedir, env });
  const missing = plan.install.filter((item) => {
    const version = installedVersion(finalState, item.name)
      || (EXACT_VERSION.test(finalState.dependencies[item.name] || '')
        ? finalState.dependencies[item.name]
        : undefined);
    return !finalState.bundles.includes(item.name) || version !== item.version;
  });
  if (missing.length > 0) {
    throw new Error(`插件同步命令已完成，但 ${profile} 仍缺少：${missing.map((item) => item.name).join('、')}。`);
  }
  return {
    ...plan,
    target: finalState,
    synced: plan.install.map((item) => item.name),
    unchanged: false,
  };
}

/**
 * Create the web profile when missing, then install or update dsh-acp-door.
 * The caller invokes this only from the explicit “prepare/repair” command.
 */
function preparePanelProfile({
  command,
  profile = 'vscode-panel',
  run = runDshSync,
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  if (!SAFE_PROFILE.test(String(profile || ''))) {
    throw new Error(`配置集名称不合法：${profile}`);
  }
  if (!String(command || '').trim()) throw new Error('没有可用的 DSH 命令。');

  let state = inspectPanelProfile(profile, { homedir, env });
  let created = false;
  if (!state.exists) {
    run({
      command,
      args: ['--profile', profile, '--from-default-profile', 'web', '--dump-config'],
      timeoutMs: 120000,
    });
    created = true;
    state = inspectPanelProfile(profile, { homedir, env });
    if (!state.exists) throw new Error(`DSH 没有创建配置集 ${profile}。`);
  }
  if (!state.hasWebApp) {
    throw new Error(`配置集 ${profile} 不是可由面板自启的 web 配置集；为避免覆盖现有配置，已停止。`);
  }

  const action = state.hasDoor ? 'update' : 'add';
  run({
    command,
    args: ['plugin', '--profile', profile, action, 'dsh-acp-door'],
    timeoutMs: 180000,
  });

  const finalState = inspectPanelProfile(profile, { homedir, env });
  if (!finalState.hasDoor) {
    throw new Error(`命令已完成，但 ${profile} 的插件清单里仍没有 dsh-acp-door。`);
  }
  const pluginSync = syncPanelProfilePlugins({
    command,
    profile,
    run,
    homedir,
    env,
  });
  return {
    profile,
    action,
    created,
    ...(pluginSync.target || finalState),
    syncedPlugins: pluginSync.synced,
    skippedPlugins: pluginSync.skipped,
  };
}

module.exports = {
  inspectPanelProfile,
  planPanelPluginSync,
  preparePanelProfile,
  profileDirectory,
  syncPanelProfilePlugins,
};
