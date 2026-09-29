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
    return { exists: false, directory, bundles: [], hasDoor: false, hasWebApp: false };
  }
  const raw = pkg?.dsh?.profile?.bundles;
  const bundles = Array.isArray(raw) ? raw.map(String) : [];
  return {
    exists: true,
    directory,
    bundles,
    hasDoor: bundles.some((name) => /(^|\/)dsh-acp-door(?:$|@)/.test(name)),
    hasWebApp: bundles.some((name) => /@deepseek-ai\/dsh-web-app/.test(name)),
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
  return { profile, action, created, ...finalState };
}

module.exports = {
  inspectPanelProfile,
  preparePanelProfile,
  profileDirectory,
};
