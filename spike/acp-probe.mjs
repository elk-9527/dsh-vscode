#!/usr/bin/env node
/**
 * M0 协议探针 —— 用真实的 `dsh --profile acp` 验证 ACP 行为，并把双向原始帧全部抓下来。
 *
 * 为什么要这么做：M1 的前端渲染必须建立在真实字段上，而不是文档推断。
 * 本脚本同时解决三件事：
 *   1. 验证 Windows 上如何 spawn dsh（dsh.cmd 是批处理 shim，Node 不能直接执行）；
 *   2. 打印 @agentclientprotocol/sdk 里真实存在的方法路径，避免手搓协议时猜错名字；
 *   3. 落盘原始帧 JSONL + 摘要 JSON，作为 M1 的 fixtures 来源。
 *
 * 用法：
 *   node spike/acp-probe.mjs            # 只跑一次最省的文本回合
 *   node spike/acp-probe.mjs --edit     # 追加一次"改文件"回合，用来抓 diff 内容
 *
 * 产物：
 *   spike/capture/<ts>-frames.jsonl  双向原始帧（c2s = 客户端发，s2c = 内核发）
 *   spike/capture/<ts>-stderr.log    内核 stderr（日志，非协议）
 *   spike/capture/<ts>-summary.json  初始化结果、会话 id、更新统计、方法路径清单
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WANT_EDIT = process.argv.includes('--edit');
const WATCHDOG_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 300_000);

// ─────────────────────────────────────────────────────────────
// 一、定位 dsh 可执行文件（M1 会把这部分提炼成 packages/extension/src/dsh/locate.ts）
// ─────────────────────────────────────────────────────────────

/** 从 dsh.cmd 里抽出 `set "K=V"` 形式的环境变量（不打印、不外传，只用于复现启动条件）。 */
function envFromShim(text) {
  const out = {};
  for (const m of text.matchAll(/^\s*set\s+"([^"]+)=([^"]*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

/**
 * 解析顺序：显式设置 > PATH 上的 dsh > 解析 Windows 批处理 shim。
 * 解析 shim 的意义：绕开 cmd.exe 这一层，直接起 `DSH Desktop.exe --expose-internals desktop-cli.js`，
 * stdio 管道更干净，也避免 .cmd 引号转义的坑。
 */
function locateDsh() {
  if (process.env.DSH_EXECUTABLE) {
    return { kind: 'explicit', command: process.env.DSH_EXECUTABLE, args: ['--profile', 'acp'], env: {} };
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
        args: ['--expose-internals', m[2], '--profile', 'acp'],
        env: envFromShim(text),
      };
    }
    // shim 形式不认识就退回 shell 启动
    return { kind: 'shell', command: 'dsh --profile acp', args: [], env: {}, shell: true, shimPath: first };
  }
  return { kind: 'path', command: first, args: ['--profile', 'acp'], env: {} };
}

// ─────────────────────────────────────────────────────────────
// 二、抓包：双向每一行都落盘，同时把 s2c 原样喂给 SDK
// ─────────────────────────────────────────────────────────────

const captureDir = join(HERE, 'capture');
mkdirSync(captureDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const framesPath = join(captureDir, `${stamp}-frames.jsonl`);
const stderrPath = join(captureDir, `${stamp}-stderr.log`);
const summaryPath = join(captureDir, `${stamp}-summary.json`);
const frames = createWriteStream(framesPath, { flags: 'a' });
const stderrLog = createWriteStream(stderrPath, { flags: 'a' });

/** 逐行切分并旁路记录，但原样透传字节。 */
function tap(dir) {
  let buf = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) frames.write(JSON.stringify({ t: Date.now(), dir, line }) + '\n');
      }
      cb(null, chunk);
    },
  });
}

// ─────────────────────────────────────────────────────────────
// 三、小工具
// ─────────────────────────────────────────────────────────────

/** 把 SDK 的方法表摊平成 "agent.session.new = session/new" 这样的路径清单。 */
function methodPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...methodPaths(v, p));
    else out.push(`${p} = ${String(v)}`);
  }
  return out;
}

const clip = (s, n = 700) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length}字)` : s);
const log = (...a) => console.log(...a);

const seen = { updates: [], toolCalls: new Map(), permissions: [], diffs: [] };

/** 更新处理：既打印给人看，也留下结构化统计。 */
async function onUpdate(notification) {
  const u = notification.update;
  const kind = u?.sessionUpdate;
  seen.updates.push(kind);

  switch (kind) {
    case 'agent_message_chunk':
      if (u.content?.type === 'text') process.stdout.write(u.content.text);
      else log(`\n[非文本消息块: ${u.content?.type}]`);
      break;

    case 'agent_thought_chunk':
      if (u.content?.type === 'text') process.stdout.write(`\x1b[2m${u.content.text}\x1b[0m`);
      break;

    case 'tool_call': {
      seen.toolCalls.set(u.toolCallId, { title: u.title, kind: u.kind, status: u.status, hasDiff: false });
      log(`\n\x1b[36m🔧 ${u.title ?? '(无标题)'}\x1b[0m  kind=${u.kind} status=${u.status}`);
      if (Array.isArray(u.locations) && u.locations.length) {
        log(`   locations: ${u.locations.map((l) => `${l.path}${l.line ? `:${l.line}` : ''}`).join(', ')}`);
      }
      collectDiff(u);
      break;
    }

    case 'tool_call_update': {
      const prev = seen.toolCalls.get(u.toolCallId);
      if (u.status) log(`\n\x1b[36m   ↳ ${u.toolCallId.slice(0, 12)} → ${u.status}\x1b[0m`);
      if (Array.isArray(u.content)) {
        for (const c of u.content) {
          if (c.type === 'diff') log(`   \x1b[33m📝 diff: ${c.path}\x1b[0m`);
          else if (c.type === 'content' && c.content?.type === 'text') log(`   ${clip(c.content.text, 200)}`);
          else log(`   [内容块 ${c.type}]`);
        }
      }
      if (prev && u.status) prev.status = u.status;
      collectDiff(u);
      break;
    }

    case 'plan':
      log(`\n[计划] ${(u.entries ?? []).map((e) => `${e.status}:${e.content}`).join(' | ')}`);
      break;

    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
      log(`\n[${kind}] ${JSON.stringify(u).slice(0, 300)}`);
      break;

    case 'user_message_chunk':
      break;

    default:
      log(`\n[未知更新类型 ${kind}] ${JSON.stringify(u).slice(0, 300)}`);
  }
}

/** ACP v1 的 diff 就在 tool call 内容里：{type:"diff", path, oldText, newText}。 */
function collectDiff(u) {
  const blocks = [];
  if (Array.isArray(u.content)) blocks.push(...u.content);
  for (const c of blocks) {
    if (c?.type === 'diff') {
      seen.diffs.push({
        toolCallId: u.toolCallId,
        path: c.path,
        oldTextLen: c.oldText?.length ?? 0,
        newTextLen: c.newText?.length ?? 0,
        isNewFile: c.oldText === null || c.oldText === undefined,
      });
      const key = u.toolCallId;
      const rec = seen.toolCalls.get(key);
      if (rec) rec.hasDiff = true;
    }
  }
}

/** 权限询问：探针自动放行（只作用于 scratch 目录），并记录选项形状。 */
async function requestPermission(params) {
  const options = params?.options ?? [];
  seen.permissions.push({
    title: params?.toolCall?.title,
    toolCallId: params?.toolCall?.toolCallId,
    options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
  });
  log(`\n\x1b[35m🔐 权限请求: ${params?.toolCall?.title ?? '(无标题)'}\x1b[0m`);
  for (const o of options) log(`     - ${o.name}  [kind=${o.kind}]  optionId=${o.optionId}`);
  const pick =
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind === 'allow_always') ??
    options[0];
  if (!pick) {
    log('  → 没有可选项，按取消处理');
    return { outcome: { outcome: 'cancelled' } };
  }
  log(`  → 探针自动选择: ${pick.name} (${pick.optionId})`);
  return { outcome: { outcome: 'selected', optionId: pick.optionId } };
}

// ─────────────────────────────────────────────────────────────
// 四、主流程
// ─────────────────────────────────────────────────────────────

const scratch = join(HERE, 'scratch');
mkdirSync(scratch, { recursive: true });
const helloPath = join(scratch, 'hello.ts');
const helloSource = `export function greet(name: string): string {
  return \`hello, \${name}\`;
}
`;
if (!existsSync(helloPath)) writeFileSync(helloPath, helloSource, 'utf8');

const summary = {
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  probe: { edit: WANT_EDIT },
  spawn: null,
  sdk: { protocolVersion: acp.PROTOCOL_VERSION },
  methods: [],
  initialize: null,
  session: null,
  listProbe: null,
  turns: [],
  stderrTail: '',
};

function finish(code) {
  summary.finishedAt = new Date().toISOString();
  summary.updates = seen.updates;
  summary.toolCalls = [...seen.toolCalls.entries()].map(([id, v]) => ({ toolCallId: id, ...v }));
  summary.permissions = seen.permissions;
  summary.diffs = seen.diffs;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  log(`\n\n──────── 产物 ────────`);
  log(`原始帧 : ${framesPath}`);
  log(`stderr : ${stderrPath}`);
  log(`摘要   : ${summaryPath}`);
  log(`更新类型统计: ${JSON.stringify(summary.updates)}`);
  log(`工具调用: ${summary.toolCalls.length} 个，抓到 diff: ${summary.diffs.length} 个`);
  frames.end();
  stderrLog.end();
  process.exit(code);
}

const watchdog = setTimeout(() => {
  log(`\n⏱ 超过 ${WATCHDOG_MS}ms 仍未结束，判定挂死，强制收尾`);
  summary.watchdogFired = true;
  try {
    child?.kill();
  } catch {}
  finish(2);
}, WATCHDOG_MS);

// ── 启动内核 ────────────────────────────────────────────────
const spec = locateDsh();
summary.spawn = { kind: spec.kind, command: spec.command, args: spec.args, shim: spec.shimPath, envKeys: Object.keys(spec.env) };
log(`启动内核: kind=${spec.kind}`);
log(`  command: ${spec.command}`);
log(`  args   : ${spec.args.join(' ')}`);
if (spec.shimPath) log(`  shim   : ${spec.shimPath}`);
log(`  注入 env: ${Object.keys(spec.env).join(', ') || '(无)'}\n`);

const child = spawn(spec.command, spec.args, {
  cwd: ROOT,
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
  process.stderr.write(`\x1b[2m[dsh] ${text}\x1b[0m`);
});
child.on('exit', (code, signal) => {
  if (!summary.finishedAt) log(`\n内核进程退出: code=${code} signal=${signal}`);
  summary.exit = { code, signal };
});
child.on('error', (err) => {
  log(`\n❌ 无法启动内核: ${err.message}`);
  summary.spawnError = err.message;
  clearTimeout(watchdog);
  finish(3);
});

// 双向抓包 + SDK 接线
const toChild = tap('c2s');
const fromChild = tap('s2c');
toChild.pipe(child.stdin);
child.stdout.pipe(fromChild);

// ── 跑协议 ─────────────────────────────────────────────────
try {
  // 先看一眼 SDK 到底有哪些方法，避免猜名字
  summary.methods = methodPaths(acp.methods);
  log(`\nSDK 方法表（ACP ${acp.PROTOCOL_VERSION}）:`);
  for (const p of summary.methods) log(`  ${p}`);

  const prompts = ['回复恰好一个词：pong'];
  if (WANT_EDIT) {
    prompts.push(
      'scratch 目录下的 hello.ts 里有一个 greet 函数。请只改这一个文件，给 greet 补上 JSDoc 注释（写清参数与返回值）。改完不要做别的事。',
    );
  }

  await acp
    .client({ name: 'dsh-vscode-probe', version: '0.0.0' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => requestPermission(ctx.params))
    // DSH 的 ACP 面不支持客户端文件系统代理，这里留桩：一旦被调用就说明前提变了
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
      log(`\n⚠️ 内核竟然调用了客户端 readTextFile: ${JSON.stringify(ctx.params).slice(0, 200)}`);
      return { content: '' };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
      log(`\n⚠️ 内核竟然调用了客户端 writeTextFile: ${JSON.stringify(ctx.params).slice(0, 200)}`);
      return {};
    })
    .connectWith(acp.ndJsonStream(Writable.toWeb(toChild), Readable.toWeb(fromChild)), async (ctx) => {
      // ① 握手
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      summary.initialize = init;
      log(`\n✅ 握手成功: protocolVersion=${init.protocolVersion} agentInfo=${JSON.stringify(init.agentInfo)}`);
      log(`   agentCapabilities=${JSON.stringify(init.agentCapabilities)}`);
      log(`   authMethods=${JSON.stringify(init.authMethods)}\n`);

      // ② 故意用空参数问一次 session/list，让校验错误把真实 schema 交代出来
      try {
        const list = await ctx.request(acp.methods.agent.session.list, {});
        summary.listProbe = { ok: true, result: list };
        log(`\n📋 session/list 成功: ${JSON.stringify(list).slice(0, 400)}`);
      } catch (e) {
        summary.listProbe = { ok: false, error: String(e?.message ?? e) };
        log(`\n📋 session/list 空参数被拒（正好用来看 schema）:\n   ${clip(String(e?.message ?? e), 900)}\n`);
      }

      // ③ 建会话并跑回合
      return ctx.buildSession(scratch).withSession(async (session) => {
        summary.session = {
          keys: Object.keys(session),
          sessionId: session.sessionId,
          // 配置选项（模型 / 推理强度）通常挂在建会话结果上，原样留档
          configOptions: session.configOptions ?? session.newSessionResponse?.configOptions ?? null,
          modes: session.modes ?? session.newSessionResponse?.modes ?? null,
        };
        log(`\n📝 会话已建: ${session.sessionId}`);
        log(`   session 上的键: ${summary.session.keys.join(', ')}`);
        if (summary.session.configOptions) {
          log(`   配置选项: ${JSON.stringify(summary.session.configOptions).slice(0, 600)}`);
        }

        // ④ 运行时切换模型：这是关键结论——模型选择是 ACP 调用，不需要改任何配置文件。
        //    acp profile 默认钉在 deepseek-official，本机那条路由的 key 无效；
        //    opencode-go 才是可用路由，而它就在 configOptions 里。
        const modelValue = process.env.PROBE_MODEL ?? '["opencode-go","deepseek-v4.1-flash"]';
        try {
          // 注意：ClientContext 只暴露 buildSession / request / notify，
          // 会话级方法（set_config_option、cancel、close…）一律走通用 request。
          const res = await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'model',
            value: modelValue,
          });
          summary.modelSwitch = { requested: modelValue, ok: true, result: res };
          log(`\n🎛 模型已切换到 ${modelValue}`);
          log(`   返回的配置状态: ${JSON.stringify(res).slice(0, 500)}`);
        } catch (e) {
          summary.modelSwitch = { requested: modelValue, ok: false, error: String(e?.message ?? e) };
          log(`\n🎛 切换模型失败: ${e?.message ?? e}`);
        }

        for (const [i, text] of prompts.entries()) {
          log(`\n\n──── 回合 ${i + 1}/${prompts.length} ────\n💬 ${text}\n`);
          const t0 = Date.now();
          session.prompt(text);
          for (;;) {
            const msg = await session.nextUpdate();
            if (msg.kind === 'stop') {
              summary.turns.push({ index: i + 1, prompt: text, stopReason: msg.response?.stopReason, ms: Date.now() - t0 });
              log(`\n\n✅ 回合 ${i + 1} 结束: stopReason=${msg.response?.stopReason} (${Date.now() - t0}ms)`);
              break;
            }
            await onUpdate(msg.notification);
          }
        }
        return summary.turns;
      });
    });

  clearTimeout(watchdog);
  summary.stderrTail = stderrTail;
  child.kill();
  finish(0);
} catch (err) {
  clearTimeout(watchdog);
  log(`\n❌ 协议流程失败: ${err?.stack ?? err}`);
  summary.error = String(err?.stack ?? err);
  summary.stderrTail = stderrTail;
  try {
    child.kill();
  } catch {}
  finish(1);
}
