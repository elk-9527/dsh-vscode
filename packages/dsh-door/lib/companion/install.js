import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export const EXTENSION_ID = 'Elk-ydy.dsh-acp-panel';
export const MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;
export const CHANNEL = '/api';
export const ENDPOINT_PREFIX = 'dsh-acp-door-companion';
const identity = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

async function exists(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/** Read installation locations without depending on a GUI process or shell PATH. */
async function windowsInstallRoots() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const outputs = await Promise.all(keys.map(key => new Promise(resolve => {
    execFile('reg.exe', ['query', key, '/s', '/v', 'InstallLocation'], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      (_, stdout) => resolve(String(stdout || '')));
  })));
  return outputs.flatMap(output => [...output.matchAll(/^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)$/gm)].map(match => match[1].trim().replace(/^"|"$/g, '')));
}

/** Run a discovered CLI directly; paths and profile names never enter a shell. */
export function runCli(editor, args, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(editor.command, [...editor.args, ...args], {
      windowsHide: true, timeout, signal, maxBuffer: 1024 * 1024,
      env: { ...process.env, VSCODE_DEV: '', ELECTRON_RUN_AS_NODE: '1', VSCODE_CLI: '1' },
    }, (error, stdout) => {
      if (error) reject(Object.assign(new Error('VS Code 命令未完成'), {
        code: signal?.aborted ? 'cancelled' : error.killed ? 'timeout' : 'cli-failed',
      }));
      else resolve(String(stdout));
    });
  });
}

/** Discover Stable/Insiders, including custom locations exposed through PATH. */
export async function discoverEditors({ platform = process.platform, env = process.env, homedir = os.homedir(), installRoots = windowsInstallRoots } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [];
  const add = (root, insiders = false) => {
    if (!root) return;
    if (platform === 'win32') candidates.push({
      command: p.join(root, insiders ? 'Code - Insiders.exe' : 'Code.exe'),
      args: [p.join(root, 'resources', 'app', 'out', 'cli.js')], insiders,
    });
    else if (platform === 'darwin') candidates.push({ command: p.join(root, 'Contents', 'Resources', 'app', 'bin', 'code'), args: [], insiders });
  };
  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (root) { add(p.join(root, 'Microsoft VS Code')); add(p.join(root, 'Microsoft VS Code Insiders'), true); }
    }
    for (const root of await installRoots()) { add(root); add(root, true); }
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', p.join(homedir, 'Applications')]) {
      add(p.join(root, 'Visual Studio Code.app')); add(p.join(root, 'Visual Studio Code - Insiders.app'), true);
    }
  }
  for (const directory of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const folder = directory.replace(/^"|"$/g, '');
    for (const insiders of [false, true]) {
      const name = insiders ? 'code-insiders' : 'code';
      if (platform === 'win32') {
        if (await exists(p.join(folder, name + '.cmd'))) add(p.dirname(folder), insiders);
      } else candidates.push({ command: p.join(folder, name), args: [], insiders });
    }
  }
  const seen = new Set(), editors = [];
  for (const candidate of candidates) {
    if (!await exists(candidate.command) || candidate.args.some(file => !file)) continue;
    if (platform === 'win32' && !await exists(candidate.args[0])) {
      // Recent VS Code updates place resources in a version directory. Read
      // the official launcher as data; never execute its batch text in a shell.
      const root = p.dirname(candidate.command);
      try {
        const launcher = await fs.readFile(p.join(root, 'bin', candidate.insiders ? 'code-insiders.cmd' : 'code.cmd'), 'utf8');
        const relative = launcher.slice(0, 16384).match(/"%~dp0([^"\r\n]*cli\.js)"/i)?.[1];
        if (relative) {
          const cli = p.resolve(root, 'bin', relative);
          const within = p.relative(root, cli);
          if (within && !within.startsWith('..') && !p.isAbsolute(within)) candidate.args = [cli];
        }
      } catch {}
    }
    if (candidate.args.length && !await exists(candidate.args[0])) continue;
    const real = await fs.realpath(candidate.command);
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    let data;
    if (platform === 'win32') data = env.APPDATA && p.join(env.APPDATA, candidate.insiders ? 'Code - Insiders' : 'Code');
    else data = platform === 'darwin' ? p.join(homedir, 'Library', 'Application Support', candidate.insiders ? 'Code - Insiders' : 'Code')
      : p.join(env.XDG_CONFIG_HOME || p.join(homedir, '.config'), candidate.insiders ? 'Code - Insiders' : 'Code');
    // Portable installations keep their profiles beside the application.
    const portable = platform === 'win32' ? p.join(p.dirname(candidate.command), 'data', 'user-data') : undefined;
    if (portable) try { if ((await fs.stat(portable)).isDirectory()) data = portable; } catch {}
    const profiles = [{ id: 'default', label: '默认配置', name: undefined }];
    if (data) try {
      const text = await fs.readFile(p.join(data, 'User', 'globalStorage', 'storage.json'), 'utf8');
      if (text.length <= 4 * 1024 * 1024) {
        const saved = JSON.parse(text).userDataProfiles;
        if (Array.isArray(saved)) for (const profile of saved.slice(0, 64)) {
          if (typeof profile?.name !== 'string' || !profile.name.trim() || profile.name.length > 256) continue;
          if (!profiles.some(item => item.name === profile.name)) profiles.push({ id: identity(profile.name), label: profile.name, name: profile.name });
        }
      }
    } catch {}
    editors.push({ ...candidate, id: identity(key), label: candidate.insiders ? 'VS Code Insiders' : 'Visual Studio Code', location: p.dirname(candidate.command), profiles });
    if (editors.length >= 12) break;
  }
  return editors;
}

/** Host-owned state and installation; a browser can select only discovered targets. */
export function createCompanionInstaller({
  home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'),
  discover = discoverEditors, run = runCli,
} = {}) {
  const stateFile = path.join(home, 'plugins', 'dsh-acp-door', 'companion.json');
  const lifetime = new AbortController();
  let pending;
  let disposed = false;
  const active = new Set();
  const assertLive = () => { if (disposed) throw Object.assign(new Error('安装服务已关闭'), { code: 'cancelled' }); };
  async function dismissed() {
    try { return JSON.parse(await fs.readFile(stateFile, 'utf8')).promptDismissed === true; } catch { return false; }
  }
  async function dismiss() {
    assertLive();
    await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporary = stateFile + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, promptDismissed: true }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, stateFile);
    } finally { await fs.rm(temporary, { force: true }); }
    return { dismissed: true };
  }
  async function target(params) {
    assertLive();
    const editor = (await discover()).find(item => item.id === params?.editorId);
    const profile = editor?.profiles.find(item => item.id === params?.profileId);
    if (!editor || !profile) throw Object.assign(new Error('编辑器或配置集已变化，请重新检测后选择'), { code: 'target-changed' });
    return { editor, args: profile.name === undefined ? [] : ['--profile', profile.name] };
  }
  async function checked(editor, args) {
    const output = await run(editor, [...args, '--list-extensions', '--show-versions'], { signal: lifetime.signal });
    const match = output.split(/\r?\n/).map(line => line.trim()).find(line => line.split('@')[0].toLowerCase() === EXTENSION_ID.toLowerCase());
    return { installed: !!match, version: match?.split('@')[1] || null };
  }
  const track = task => {
    assertLive();
    const promise = task(); active.add(promise);
    promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  };
  return {
    status: () => track(async () => ({
      dismissed: await dismissed(), extensionId: EXTENSION_ID, marketplace: MARKETPLACE_URL,
      editors: (await discover()).map(({ id, label, location, profiles }) => ({ id, label, location, profiles: profiles.map(({ id, label }) => ({ id, label })) })),
    })),
    dismiss: () => track(dismiss),
    check: params => track(async () => { const { editor, args } = await target(params); return checked(editor, args); }),
    install(params) {
      return track(async () => {
        if (params?.confirmed !== true) throw Object.assign(new Error('请点击安装按钮后再安装'), { code: 'confirmation-required' });
        if (pending) throw Object.assign(new Error('正在安装，请等待结果'), { code: 'busy' });
        // Claim the slot before the first asynchronous discovery/read.
        pending = (async () => {
          const { editor, args } = await target(params);
          let result = await checked(editor, args);
          if (!result.installed) {
            await run(editor, [...args, '--install-extension', EXTENSION_ID], { signal: lifetime.signal, timeout: 180000 });
            result = await checked(editor, args);
          }
          if (!result.installed) throw Object.assign(new Error('尚未检测到配套扩展，请重试或从扩展市场安装'), { code: 'verification-failed' });
          // An unwritable preference file must not turn a verified install into a failure.
          try { await dismiss(); } catch {}
          return result;
        })();
        try { return await pending; } finally { pending = undefined; }
      });
    },
    async dispose() {
      disposed = true; lifetime.abort();
      await Promise.allSettled([...active]);
    },
  };
}

/** Optional Connection seam leaves headless and older DSH kernels operational. */
export function registerCompanion(ctx, options) {
  ctx.inject(['connection'], scope => {
    if (typeof scope.connection?.fetch?.register !== 'function') return;
    const installer = createCompanionInstaller(options);
    // Exact Connection Fetch routes admit only authenticated owner Peers and
    // share /api across HTTP and native carriers. Do not create a second wire.
    const removers = ['status', 'check', 'install', 'dismiss'].map(endpoint => scope.connection.fetch.register({
      path: `${CHANNEL}/${ENDPOINT_PREFIX}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid request', { status: 400 }); }
        if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || body.rpcId.length > 128 || !body.rpcId
          || body.method !== `${ENDPOINT_PREFIX}/${endpoint}`) return new Response('Invalid request', { status: 400 });
        let result;
        try {
          request.signal.throwIfAborted();
          result = { ok: true, value: await installer[endpoint](body.payload) };
        } catch (error) {
          result = { ok: false, error: { code: error.code || 'unavailable', message: error.code ? error.message : '无法完成操作，请重新检测或从扩展市场安装', details: {} } };
        }
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result });
      },
    }));
    return async () => { await Promise.all([...removers.map(remove => remove()), installer.dispose()]); };
  });
}
