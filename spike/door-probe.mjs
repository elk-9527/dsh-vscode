#!/usr/bin/env node
/**
 * 第 0 步前置校验：验证 ACP 接入点插件（`dsh-acp-door`）是否将外部程序接入了**正在运行的内核**。
 *
 * 与 acp-probe.mjs 的区别：本脚本**不启动任何新进程**，
 * 仅通过 TCP 连接该插件开启的回环端口。
 *
 * 需要证明三件事：
 *   1. 该插件能够握手（说明 ACP 桥已挂载）；
 *   2. 能够建立会话、执行回合（说明复用真实内核，而非空壳）；
 *   3. **会话已获取工具**（桌面端关闭了全局工具行，改为按会话挂载 ——
 *      该条是乙方案能否成立的关键，因此专门使用一个"必须读文件"的回合验证）。
 *
 * 用法：
 *   node spike/door-probe.mjs
 *   环境变量：DOOR_PORT（默认 47821）、DOOR_TIMEOUT_MS、PROBE_MODEL
 *
 * 产物：spike/capture/<ts>-door.json、<ts>-door-frames.jsonl
 */
import net from 'node:net';
import { Duplex } from 'node:stream';
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DOOR_PORT ?? 47821);
const HOST = '127.0.0.1';
const WATCHDOG_MS = Number(process.env.DOOR_TIMEOUT_MS ?? 240_000);

const captureDir = join(HERE, 'capture');
mkdirSync(captureDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const framesPath = join(captureDir, `${stamp}-door-frames.jsonl`);
const reportPath = join(captureDir, `${stamp}-door.json`);
const frames = createWriteStream(framesPath, { flags: 'a' });

const log = (...a) => console.log(...a);
const clip = (s, n = 400) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length}字)` : s);

const seen = { updates: [], toolCalls: new Map() };
const report = {
  startedAt: new Date().toISOString(),
  target: `${HOST}:${PORT}`,
  probe: { model: process.env.PROBE_MODEL ?? null },
  initialize: null,
  listProbe: null,
  session: null,
  turns: [],
  verdict: {},
};

/** 旁路记录一方向的原始帧，同时原样放行。 */
function tap(dir) {
  let buf = '';
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) frames.write(JSON.stringify({ t: Date.now(), dir, line }) + '\n');
      }
      ctrl.enqueue(chunk);
    },
  });
}

async function onUpdate(notification) {
  const u = notification.update;
  const kind = u?.sessionUpdate;
  seen.updates.push(kind);

  switch (kind) {
    case 'agent_message_chunk':
      if (u.content?.type === 'text') process.stdout.write(u.content.text);
      break;
    case 'agent_thought_chunk':
      if (u.content?.type === 'text') process.stdout.write(`\x1b[2m${u.content.text}\x1b[0m`);
      break;
    case 'tool_call':
      seen.toolCalls.set(u.toolCallId, { title: u.title, kind: u.kind, status: u.status });
      log(`\n\x1b[36m🔧 ${u.title ?? '(无标题)'}\x1b[0m  kind=${u.kind} status=${u.status}`);
      if (u.rawInput) log(`   rawInput: ${clip(JSON.stringify(u.rawInput), 220)}`);
      break;
    case 'tool_call_update': {
      const prev = seen.toolCalls.get(u.toolCallId);
      if (prev && u.status) prev.status = u.status;
      log(`\n\x1b[36m   ↳ ${String(u.toolCallId).slice(0, 14)} → ${u.status}\x1b[0m`);
      if (Array.isArray(u.content)) {
        for (const c of u.content) {
          if (c.type === 'content' && c.content?.type === 'text') log(`   ${clip(c.content.text, 260)}`);
          else log(`   [内容块 ${c.type}]`);
        }
      }
      break;
    }
    case 'usage_update':
      report.lastUsage = { used: u.used, size: u.size };
      break;
    default:
      log(`\n[${kind}] ${clip(JSON.stringify(u), 220)}`);
  }
}

async function requestPermission(params) {
  const options = params?.options ?? [];
  log(`\n\x1b[35m🔐 权限请求: ${params?.toolCall?.title ?? '(无标题)'}\x1b[0m`);
  for (const o of options) log(`     - ${o.name} [kind=${o.kind}]`);
  const pick =
    options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? options[0];
  if (!pick) return { outcome: { outcome: 'cancelled' } };
  log(`  → 自动放行: ${pick.name}`);
  return { outcome: { outcome: 'selected', optionId: pick.optionId } };
}

function finish(code) {
  report.finishedAt = new Date().toISOString();
  report.updates = seen.updates;
  report.toolCalls = [...seen.toolCalls.entries()].map(([id, v]) => ({ toolCallId: id, ...v }));
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  log(`\n\n──────── 结论 ────────`);
  log(`与该插件的握手   : ${report.verdict.handshake ?? '未完成'}`);
  log(`建会话           : ${report.verdict.session ?? '未完成'}`);
  log(`回合完成         : ${report.verdict.turn ?? '未完成'}`);
  log(`会话拿到工具了吗 : ${report.verdict.tools ?? '未能判断'}`);
  log(`工具调用明细     : ${report.toolCalls.map((t) => `${t.title}(${t.status})`).join(', ') || '(无)'}`);
  log(`\n原始帧 : ${framesPath}`);
  log(`报告   : ${reportPath}`);
  frames.end();
  process.exit(code);
}

const watchdog = setTimeout(() => {
  log(`\n⏱ 超过 ${WATCHDOG_MS}ms 仍未结束，强制收尾`);
  report.watchdogFired = true;
  finish(2);
}, WATCHDOG_MS);

const scratch = join(HERE, 'scratch');
mkdirSync(scratch, { recursive: true });
const helloPath = join(scratch, 'hello.ts');
if (!existsSync(helloPath)) {
  writeFileSync(helloPath, 'export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n', 'utf8');
}

// ── 连接 ACP 接入点插件（`dsh-acp-door`） ───────────────────
log(`连接该插件 ${HOST}:${PORT} …`);
const socket = await new Promise((res, rej) => {
  const s = net.connect(PORT, HOST);
  s.once('connect', () => res(s));
  s.once('error', (e) => rej(new Error(`无法连接该插件（${HOST}:${PORT}）：${e.message}`)));
});
socket.setNoDelay(true);
log('✅ 已连上');

// 同一个 socket，两个方向各自旁路记录，然后交给 SDK。
const { readable: socketRead, writable: socketWrite } = Duplex.toWeb(socket);
const outboundLog = tap('c2s');
const inboundLog = tap('s2c');
// SDK 写入 → 先经记录 → 再写入 socket；socket 收到 → 先经记录 → 再交由 SDK 读取。
outboundLog.readable.pipeTo(socketWrite).catch(() => {});
const stream = acp.ndJsonStream(outboundLog.writable, socketRead.pipeThrough(inboundLog));

try {
  await acp
    .client({ name: 'dsh-door-probe', version: '0.0.0' })
    .onRequest(acp.methods.client.session.requestPermission, (c) => requestPermission(c.params))
    .onRequest(acp.methods.client.fs.readTextFile, (c) => {
      log(`\n⚠️ 内核调用了客户端 readTextFile: ${clip(JSON.stringify(c.params), 200)}`);
      return { content: '' };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      report.initialize = init;
      report.verdict.handshake = `✅ protocolVersion=${init.protocolVersion} agentInfo=${JSON.stringify(init.agentInfo)}`;
      log(`\n${report.verdict.handshake}`);

      try {
        const list = await ctx.request(acp.methods.agent.session.list, {});
        report.listProbe = { ok: true, count: Array.isArray(list?.sessions) ? list.sessions.length : null };
        log(`📋 该插件能列出已有会话：${JSON.stringify(report.listProbe)}  ← 说明它读的是同一份会话记录`);
      } catch (e) {
        report.listProbe = { ok: false, error: String(e?.message ?? e) };
        log(`📋 session/list 失败: ${clip(report.listProbe.error, 300)}`);
      }

      return ctx.buildSession(scratch).withSession(async (session) => {
        report.session = { sessionId: session.sessionId };
        report.verdict.session = `✅ ${session.sessionId}`;
        log(`📝 会话: ${session.sessionId}`);

        const modelValue = process.env.PROBE_MODEL ?? '["opencode-go","deepseek-v4.1-flash"]';
        try {
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'model',
            value: modelValue,
          });
          log(`🎛 模型 → ${modelValue}`);
        } catch (e) {
          report.modelSwitchError = String(e?.message ?? e);
          log(`🎛 切模型失败（继续）: ${clip(report.modelSwitchError, 200)}`);
        }

        // 该回合是前置校验的核心：必须使用工具才能正确作答。
        const prompts = [
          `用你的工具读取文件，把它的第 1 行原样贴给我。文件路径：${helloPath} 。只做这一件事，不要解释。`,
        ];

        for (const [i, text] of prompts.entries()) {
          log(`\n──── 回合 ${i + 1}/${prompts.length} ────\n💬 ${clip(text, 200)}\n`);
          const t0 = Date.now();
          session.prompt(text);
          for (;;) {
            const msg = await session.nextUpdate();
            if (msg.kind === 'stop') {
              report.turns.push({ index: i + 1, stopReason: msg.response?.stopReason, ms: Date.now() - t0 });
              report.verdict.turn = `✅ stopReason=${msg.response?.stopReason} (${Date.now() - t0}ms)`;
              log(`\n${report.verdict.turn}`);
              break;
            }
            await onUpdate(msg.notification);
          }
        }

        // 判定：只要存在一次工具成功执行，即说明会话已获取工具。
        const calls = [...seen.toolCalls.values()];
        const ran = calls.filter((c) => c.status === 'completed' || c.status === 'in_progress');
        if (calls.length === 0) {
          report.verdict.tools =
            '❌ 一次工具调用都没有 —— 会话可能没挂上工具集（桌面端已关闭全局工具行，改由 preset 挂载）';
        } else if (ran.length === 0) {
          report.verdict.tools = `⚠️ 有工具调用但都没跑起来：${calls.map((c) => `${c.title}=${c.status}`).join(', ')}`;
        } else {
          report.verdict.tools = `✅ 会话确实拿到了工具，且真的执行了：${ran.map((c) => c.title).join(', ')}`;
        }
        return report.turns;
      });
    });

  clearTimeout(watchdog);
  socket.end();
  finish(report.verdict.tools?.startsWith('✅') && report.verdict.turn?.startsWith('✅') ? 0 : 1);
} catch (err) {
  clearTimeout(watchdog);
  log(`\n❌ 失败: ${err?.stack ?? err}`);
  report.error = String(err?.stack ?? err);
  try {
    socket.destroy();
  } catch {}
  finish(1);
}
