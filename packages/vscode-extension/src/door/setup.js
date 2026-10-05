'use strict';

/** Prepare or repair the command-line profile used by the VS Code panel. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDshSync } = require('./locate');
const { resolveSessionsRoot } = require('../dsh/sessions');

const SAFE_PROFILE = /^[A-Za-z0-9._-]+$/;
const OFFICIAL_RUNTIME_BUNDLE = /^@deepseek-ai\/dsh-[A-Za-z0-9._-]+$/;

function profileDirectory(profile, { homedir = os.homedir(), env = process.env } = {}) {
  const home = path.dirname(resolveSessionsRoot({ homedir, env }));
  return path.join(home, 'profiles', profile);
}

/**
 * 自启 vscode-panel 时只读加载 desktop 的配置覆盖层。
 *
 * 插件包与 bundle 只决定“代码是否存在”；模型路由、插件开关和插件参数实际保存在
 * profile 的 cordis.patch.yml 中。通过 DSH 自身的 `--patch` 叠加源文件，既能使用
 * desktop 的当前配置，又不复制、不覆盖任何一边的文件。
 */
function desktopProfilePatchArgs({
  profile = 'vscode-panel',
  sourceProfile = 'desktop',
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  if (!SAFE_PROFILE.test(String(profile || '')) || !SAFE_PROFILE.test(String(sourceProfile || ''))) {
    throw new Error('配置继承使用的配置集名称不合法。');
  }
  if (profile !== 'vscode-panel' || profile === sourceProfile) return [];
  const patch = path.join(profileDirectory(sourceProfile, { homedir, env }), 'cordis.patch.yml');
  try {
    if (!fs.statSync(patch).isFile()) return [];
  } catch {
    return [];
  }
  return ['--patch', patch];
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

/**
 * DSH Desktop 0.2 会把一部分官方 bundle 随运行时一起发布，并直接写入 desktop 的
 * dsh.profile.bundles；这些包不属于 profile.dependencies，因此不能走 `dsh plugin add`。
 *
 * vscode-panel 与 desktop 由同一个本机 DSH 运行时加载，故可安全复用这些官方 bundle
 * 名称。第三方无依赖条目不作同样推断，避免把无法解析的手工清单复制过去。
 */
function runtimeBundleAdditions(source, target) {
  const declaredDependencies = new Set(Object.keys(source.dependencies));
  return source.bundles.filter((name) => (
    OFFICIAL_RUNTIME_BUNDLE.test(name)
    && !declaredDependencies.has(name)
    && !target.bundles.includes(name)
  ));
}

/** 只改面板 profile 的 bundle 清单；调用点位于内核启动前，不触碰 desktop。 */
function enableRuntimeBundles(profile, state, names, options = {}) {
  if (!Array.isArray(names) || names.length === 0) return state;
  const manifest = path.join(state.directory, 'package.json');
  const original = fs.readFileSync(manifest, 'utf8');
  const pkg = JSON.parse(original);
  const profileConfig = pkg?.dsh?.profile;
  if (!profileConfig || !Array.isArray(profileConfig.bundles)) {
    throw new Error(`配置集清单缺少 dsh.profile.bundles：${manifest}`);
  }
  const additions = names.filter((name) => !profileConfig.bundles.includes(name));
  if (additions.length === 0) return state;
  profileConfig.bundles.push(...additions);
  try {
    fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  } catch (error) {
    try {
      fs.writeFileSync(manifest, original, 'utf8');
    } catch {
      // 保留原始写入错误；恢复失败时该错误仍最能说明操作为何没有完成。
    }
    throw error;
  }
  return inspectPanelProfile(profile, options);
}

/** 标准 npm 版本号；同步时固定到源配置集的实际版本，不把范围继续扩散到目标配置集。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 计算 desktop → 面板自启配置集的插件差异，不执行任何命令。
 *
 * 注册表插件只同步同时出现在 `dependencies` 与 `dsh.profile.bundles` 中的直接依赖：
 * 前者给出来源，后者证明该包当前确实启用。除此之外，desktop 中由同一 DSH 运行时
 * 提供的官方 bundle（例如 0.2 的 experimental-auto-review）按 bundle 名启用，不重复安装。
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
  const runtimeBundles = runtimeBundleAdditions(source, target);

  if (!source.exists || !target.exists) {
    return { source, target, install, runtimeBundles: [], skipped };
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

  return { source, target, install, runtimeBundles, skipped };
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
  if (!plan.source.exists || !plan.target.exists) {
    return { ...plan, synced: [], unchanged: true };
  }
  if (plan.install.length === 0 && plan.runtimeBundles.length === 0) {
    return { ...plan, synced: [], unchanged: true };
  }
  if (!plan.target.hasWebApp) {
    throw new Error(`配置集 ${profile} 不是可由面板自启的 web 配置集；未同步桌面端插件。`);
  }
  if (plan.install.length > 0 && !String(command || '').trim()) {
    throw new Error('没有可用的 DSH 命令。');
  }

  if (plan.install.length > 0) {
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
  }

  let finalState = inspectPanelProfile(profile, { homedir, env });
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
  finalState = enableRuntimeBundles(profile, finalState, plan.runtimeBundles, { homedir, env });
  const missingRuntimeBundles = plan.runtimeBundles.filter((name) => !finalState.bundles.includes(name));
  if (missingRuntimeBundles.length > 0) {
    throw new Error(`配置集 ${profile} 仍缺少运行时 bundle：${missingRuntimeBundles.join('、')}。`);
  }
  return {
    ...plan,
    target: finalState,
    synced: [...plan.install.map((item) => item.name), ...plan.runtimeBundles],
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
  desktopProfilePatchArgs,
  inspectPanelProfile,
  planPanelPluginSync,
  preparePanelProfile,
  profileDirectory,
  runtimeBundleAdditions,
  syncPanelProfilePlugins,
};
