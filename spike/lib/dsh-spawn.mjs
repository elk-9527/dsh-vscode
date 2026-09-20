/**
 * 启动 dsh 的 ACP 内核进程：定位可执行文件、spawn、双向抓包。
 *
 * M0 期间该逻辑由三个探针共用；M1 将其提炼为
 * packages/extension/src/dsh/{locate,process}.ts，本文件为该实现的行为基准。
 *
 * profile 由环境变量 DSH_PROFILE 决定：
 *   - `acp`    官方精简 ACP 面（仅包含 dsh-base + dsh-acp-app）
 *   - `vscode` 与桌面端相同的插件集合 + ACP 出口（记忆/技能/工具与桌面端一致）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { Transform } from 'node:stream';

const PROFILE = process.env.DSH_PROFILE ?? 'acp';

/** 从 dsh.cmd 中提取 `set "K=V"` 环境变量（仅用于复现启动条件，不外传）。 */
function envFromShim(text) {
  const out = {};
  for (const m of text.matchAll(/^\s*set\s+"([^"]+)=([^"]*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

/**
 * 解析顺序：显式设置 > PATH > 解析 Windows 批处理 shim。
 *
 * 解析 shim 的作用：绕过 cmd.exe，直接启动
 * `"DSH Desktop.exe" --expose-internals <...>\lib\desktop-cli.js`，
 * stdio 管道更为简洁，同时避免 .cmd 的引号转义问题。
 */
export function locateDsh() {
  if (process.env.DSH_EXECUTABLE) {
    return { kind: 'explicit', command: process.env.DSH_EXECUTABLE, args: ['--profile', PROFILE], env: {} };
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(which, ['dsh'], { encoding: 'utf8' });
  if (found.error) throw new Error(`找不到 dsh：${found.error.message}`);
  const first = (found.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (!first) throw new Error('PATH 上没有 dsh，且未设置 DSH_EXECUTABLE');

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(first)) {
    const text = readFileSync(first, 'utf8');
    const m = /\s*"([^"]+\.exe)"\s+--expose-internals\s+"([^"]+\.js)"/i.exec(text);
    if (m) {
      return {
        kind: 'shim',
        shimPath: first,
        command: m[1],
        args: ['--expose-internals', m[2], '--profile', PROFILE],
        env: envFromShim(text),
      };
    }
    return { kind: 'shell', command: `dsh --profile ${PROFILE}`, args: [], env: {}, shell: true, shimPath: first };
  }
  return { kind: 'path', command: first, args: ['--profile', PROFILE], env: {} };
}

/** 逐行切分并旁路记录，同时原样透传字节。 */
function tap(dir, onLine) {
  let buf = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine({ t: Date.now(), dir, line });
      }
      cb(null, chunk);
    },
  });
}

/**
 * 启动内核并返回可交给 acp.ndJsonStream 的两个 web 流。
 *
 * @param {object} o
 * @param {string} o.cwd        子进程工作目录
 * @param {string} o.captureDir 抓包目录（帧 JSONL + stderr 日志）
 * @param {string} o.tag        抓包文件名前缀
 * @param {(s:string)=>void} [o.onStderr]
 */
export function launchDsh({ cwd, captureDir, tag, onStderr }) {
  mkdirSync(captureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${tag}`;
  const framesPath = `${captureDir}/${base}-frames.jsonl`;
  const stderrPath = `${captureDir}/${base}-stderr.log`;
  const frames = createWriteStream(framesPath, { flags: 'a' });
  const stderrLog = createWriteStream(stderrPath, { flags: 'a' });

  const spec = locateDsh();
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: Boolean(spec.shell),
  });

  let stderrTail = '';
  child.stderr.on('data', (d) => {
    stderrLog.write(d);
    const text = d.toString('utf8');
    stderrTail = (stderrTail + text).slice(-8000);
    onStderr?.(text);
  });

  const toChild = tap('c2s', (r) => frames.write(JSON.stringify(r) + '\n'));
  const fromChild = tap('s2c', (r) => frames.write(JSON.stringify(r) + '\n'));
  toChild.pipe(child.stdin);
  child.stdout.pipe(fromChild);

  return {
    spec,
    profile: PROFILE,
    child,
    toChild,
    fromChild,
    framesPath,
    stderrPath,
    get stderrTail() {
      return stderrTail;
    },
    close() {
      try {
        child.kill();
      } catch {}
      frames.end();
      stderrLog.end();
    },
  };
}
