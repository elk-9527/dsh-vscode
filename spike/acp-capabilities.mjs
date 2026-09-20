#!/usr/bin/env node
/**
 * ACP 能力矩阵探针：逐个探测 DSH 的 ACP 面实现了哪些方法。
 *
 * 设置该探针的原因：`@agentclientprotocol/sdk` 的 methods 表是**整个 ACP 规范**的方法表，
 * 不代表 DSH 已实现其中的全部方法。dsh-acp 的 initialize 只公布了一部分 capability
 * （close / list / resume），其余方法需要实测确认。
 *
 * 方法：使用**不存在的 sessionId** 调用写操作，可安全区分三种情况：
 *   - 方法未实现           → code -32601 (method not found)
 *   - 已实现但参数或会话无效 → 参数校验错误或 not found 类错误
 *   - 实际成功             → 该结果具有风险，说明方法接受任意 id（本脚本不会触发）
 *
 * 用法：node spike/acp-capabilities.mjs
 * 产物：spike/capture/<ts>-capabilities-*.json
 */
import { Readable, Writable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';
import { launchDsh } from './lib/dsh-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CAPTURE = join(HERE, 'capture');
const BOGUS = 'does-not-exist-0000';
const log = (...a) => console.log(...a);
const clip = (s, n = 220) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

const matrix = [];

async function probe(label, fn) {
  try {
    const result = await fn();
    matrix.push({ label, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    log(`  ✅ ${label}${result === undefined ? '' : `  → ${clip(JSON.stringify(result), 160)}`}`);
    return result;
  } catch (e) {
    matrix.push({ label, ok: false, code: e?.code ?? null, error: clip(e?.message ?? e, 300) });
    log(`  ❌ ${label}  code=${e?.code ?? '-'}  ${clip(e?.message ?? e, 160)}`);
    return undefined;
  }
}

const dsh = launchDsh({
  cwd: ROOT,
  captureDir: CAPTURE,
  tag: 'capabilities',
  onStderr: (t) => process.stderr.write(`\x1b[2m[dsh] ${t}\x1b[0m`),
});
log(`内核: ${dsh.spec.command}  (${dsh.spec.kind})\n`);

const summary = { startedAt: new Date().toISOString(), spawn: { kind: dsh.spec.kind, command: dsh.spec.command }, matrix };

try {
  await acp
    .client({ name: 'dsh-vscode-capabilities', version: '0.0.0' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    .connectWith(acp.ndJsonStream(Writable.toWeb(dsh.toChild), Readable.toWeb(dsh.fromChild)), async (ctx) => {
      await probe('initialize', () =>
        ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        }),
      );

      // 探针自身的会话；所有写操作均以该会话为目标，不涉及用户的历史会话
      const session = await ctx.buildSession(join(HERE, 'scratch')).start();
      const sid = session.sessionId;
      log(`\n靶子会话: ${sid}\n`);

      log('── 只读 / 无害探测 ──');
      await probe('providers/list {}', () => ctx.request(acp.methods.agent.providers.list, {}));
      await probe('session/list {cwd}', () => ctx.request(acp.methods.agent.session.list, { cwd: ROOT }));

      log('\n── 用不存在的 sessionId 探测写操作（安全区分未实现 vs 参数错）──');
      await probe('session/delete(bogus)', () => ctx.request(acp.methods.agent.session.delete, { sessionId: BOGUS }));
      await probe('session/fork(bogus)', () => ctx.request(acp.methods.agent.session.fork, { sessionId: BOGUS }));
      await probe('session/load(bogus)', () => ctx.request(acp.methods.agent.session.load, { sessionId: BOGUS, cwd: ROOT, mcpServers: [] }));
      await probe('session/resume(bogus)', () => ctx.request(acp.methods.agent.session.resume, { sessionId: BOGUS, cwd: ROOT, mcpServers: [] }));
      await probe('session/set_mode {}', () => ctx.request(acp.methods.agent.session.setMode, { sessionId: sid, modeId: 'no-such-mode' }));
      await probe('session/cancel(空闲)', () => ctx.request(acp.methods.agent.session.cancel, { sessionId: sid }));

      log('\n── document/* 支持情况（决定 M2 能否把编辑器状态推给内核）──');
      await probe('document/didFocus', () => ctx.notify(acp.methods.agent.document.didFocus, { sessionId: sid }));
      await probe('document/didOpen', () =>
        ctx.notify(acp.methods.agent.document.didOpen, { sessionId: sid, path: join(HERE, 'scratch', 'hello.ts') }),
      );
      await probe('document/didChange', () =>
        ctx.notify(acp.methods.agent.document.didChange, { sessionId: sid, path: join(HERE, 'scratch', 'hello.ts'), text: 'x' }),
      );

      log('\n── 取消是真能中断，还是只是礼貌？──');
      const t0 = Date.now();
      const stopped = (async () => {
        session.prompt('请写一篇 3000 字的中文散文，主题是海。');
        for (;;) {
          const m = await session.nextUpdate();
          if (m.kind === 'stop') return m.response;
        }
      })();
      await new Promise((r) => setTimeout(r, 1200));
      const cancelResult = await probe('session/cancel(进行中)', () =>
        ctx.request(acp.methods.agent.session.cancel, { sessionId: sid }),
      );
      const resp = await stopped;
      summary.cancel = {
        requested: cancelResult !== undefined,
        stopReason: resp?.stopReason,
        elapsedMs: Date.now() - t0,
      };
      log(`\n  ⏹ 回合终止: stopReason=${resp?.stopReason}  (${Date.now() - t0}ms)`);

      log('\n── 收尾：关闭探针自己的会话 ──');
      await probe('session/close(自己)', () => ctx.request(acp.methods.agent.session.close, { sessionId: sid }));
      session.dispose();
      return summary;
    });

  summary.finishedAt = new Date().toISOString();
} catch (e) {
  summary.fatal = String(e?.stack ?? e);
  log(`\n❌ 失败: ${e?.message ?? e}`);
} finally {
  dsh.close();
}

const out = join(CAPTURE, `${new Date().toISOString().replace(/[:.]/g, '-')}-capabilities.json`);
writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');
log(`\n── 能力矩阵 ──`);
for (const m of matrix) {
  const mark = m.ok ? '✅' : m.code === -32601 ? '⛔ 未实现' : '⚠️';
  log(`${mark}  ${m.label}`);
}
log(`\n产物: ${out}`);
log(`原始帧: ${dsh.framesPath}`);
process.exit(0);
