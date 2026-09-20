#!/usr/bin/env node
/**
 * ACP 验证探针（第二轮）：回答 M1/M2 必须先确定的三件事：
 *   ① 运行时切换模型（session/set_config_option）→ 已在第一轮验证，此处固化该结论；
 *   ② 停止按钮的实现方式（session/cancel 未实现，改用 AbortSignal → $/cancel_request）；
 *   ③ 历史会话恢复（session/resume）是否可用，以及"全局 session/update 路由"是否可行。
 *
 * ③ 的意义：SDK 的 buildSession/ActiveSession 只覆盖 session/new。
 *   若需同时支持"新建"与"恢复"，则需要在连接级别按 sessionId 自行路由更新。
 *   本探针使用 onNotification 全局订阅验证该方案可行。
 *
 * 用法：node spike/acp-verify.mjs
 */
import { Readable, Writable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';
import { launchDsh } from './lib/dsh-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRATCH = join(HERE, 'scratch');
const CAPTURE = join(HERE, 'capture');
const MODEL = process.env.PROBE_MODEL ?? '["opencode-go","deepseek-v4.1-flash"]';
const log = (...a) => console.log(...a);
const clip = (s, n = 240) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

const report = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  log(`  ${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : `  — ${clip(JSON.stringify(detail), 200)}`}`);
};

/** 全局更新路由：验证"单个连接上多个会话按 sessionId 分流"可行。 */
const updatesBySession = new Map();
function routeUpdate(n) {
  const sid = n.sessionId;
  const arr = updatesBySession.get(sid) ?? [];
  arr.push(n.update?.sessionUpdate);
  updatesBySession.set(sid, arr);
}

const dsh = launchDsh({
  cwd: ROOT,
  captureDir: CAPTURE,
  tag: 'verify',
  onStderr: (t) => process.stderr.write(`\x1b[2m[dsh] ${t}\x1b[0m`),
});
log(`内核: ${dsh.spec.command}  (${dsh.spec.kind})\n`);

try {
  await acp
    .client({ name: 'dsh-vscode-verify', version: '0.0.0' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    .onNotification(acp.methods.client.session.update, (ctx) => routeUpdate(ctx.params))
    .connectWith(acp.ndJsonStream(Writable.toWeb(dsh.toChild), Readable.toWeb(dsh.fromChild)), async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      report.initialize = { protocolVersion: init.protocolVersion, capabilities: init.agentCapabilities };
      check('initialize', init.protocolVersion === 1, init.agentCapabilities);

      // ── 选取一个历史会话作为恢复目标（仅选取 scratch 目录下的会话，不涉及桌面端会话）──
      const list = await ctx.request(acp.methods.agent.session.list, { cwd: SCRATCH });
      const candidate = list.sessions?.[0]?.sessionId ?? null;
      report.sessionList = { cwd: SCRATCH, count: list.sessions?.length ?? 0, candidate };
      check('session/list 支持 cwd 过滤', Array.isArray(list.sessions), { count: list.sessions?.length ?? 0 });

      // ── 新建会话并切换模型 ──
      const session = await ctx.buildSession(SCRATCH).start();
      const sid = session.sessionId;
      const cfg = await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: sid,
        configId: 'model',
        value: MODEL,
      });
      const nowModel = cfg.configOptions?.find((o) => o.id === 'model')?.currentValue;
      check('session/set_config_option 运行时切模型', nowModel === MODEL, { currentValue: nowModel });

      // reasoning_effort：公布出来的选项未必被具体路由接受（实测 low 被 opencode-go 拒绝），
      // 因此逐个探测并记录真实可用的集合 —— 该集合决定 M1 的 UI 如何呈现"不可用"。
      const effortOptions = (cfg.configOptions?.find((o) => o.id === 'reasoning_effort')?.options ?? []).map(
        (o) => o.value,
      );
      report.effortProbe = { advertised: effortOptions, accepted: [], rejected: [] };
      for (const v of effortOptions) {
        try {
          const r = await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: sid,
            configId: 'reasoning_effort',
            value: v,
          });
          const cur = r.configOptions?.find((o) => o.id === 'reasoning_effort')?.currentValue;
          if (cur === v) report.effortProbe.accepted.push(v);
          else report.effortProbe.rejected.push({ value: v, why: `静默未生效，currentValue=${cur}` });
        } catch (e) {
          report.effortProbe.rejected.push({ value: v, why: String(e?.message ?? e) });
        }
      }
      log(`  🎛 推理强度：可用 [${report.effortProbe.accepted.join(', ')}]，被拒 ${report.effortProbe.rejected.length} 个`);
      check(
        'reasoning_effort 可用集合已实测',
        report.effortProbe.accepted.length > 0,
        report.effortProbe,
      );
      // 恢复为安全值，避免影响后续回合
      if (report.effortProbe.accepted.includes('high')) {
        await ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId: sid,
          configId: 'reasoning_effort',
          value: 'high',
        });
      }

      // ── ② 停止按钮：AbortSignal → $/cancel_request ──
      log('\n── 停止按钮测试 ──');
      const ac = new AbortController();
      const t0 = Date.now();
      const turn = (async () => {
        const p = session.prompt('请写一篇 3000 字的中文散文，主题是海。', { cancellationSignal: ac.signal });
        for (;;) {
          const m = await session.nextUpdate();
          if (m.kind === 'stop') return m.response;
        }
      })();
      await new Promise((r) => setTimeout(r, 1200));
      log(`  （已发出 abort，中断在途 prompt）`);
      ac.abort();
      let cancelled = null;
      let cancelErr = null;
      try {
        cancelled = await turn;
      } catch (e) {
        cancelErr = String(e?.message ?? e);
      }
      report.cancel = {
        stopReason: cancelled?.stopReason ?? null,
        error: cancelErr,
        elapsedMs: Date.now() - t0,
        updates: updatesBySession.get(sid) ?? [],
      };
      check(
        'AbortSignal 能中断回合',
        cancelled?.stopReason === 'cancelled' || Boolean(cancelErr),
        { stopReason: cancelled?.stopReason ?? null, error: cancelErr, ms: Date.now() - t0 },
      );

      // 验证中断后同一会话是否仍可使用（可用是会话状态稳定的前提）
      const after = await (async () => {
        session.prompt('回复恰好一个词：alive');
        for (;;) {
          const m = await session.nextUpdate();
          if (m.kind === 'stop') return m.response;
        }
      })();
      check('中断后同一会话仍可用', after?.stopReason === 'end_turn', { stopReason: after?.stopReason });

      await ctx.request(acp.methods.agent.session.close, { sessionId: sid });
      session.dispose();
      report.closedSession = sid;

      // ── ③ 恢复历史会话并验证全局更新路由 ──
      log('\n── 会话恢复测试 ──');
      if (!candidate) {
        check('session/resume', false, '没有可恢复的历史会话（先跑一次 acp-probe.mjs 生成）');
      } else {
        try {
          const resumed = await ctx.request(acp.methods.agent.session.resume, {
            sessionId: candidate,
            cwd: SCRATCH,
            mcpServers: [],
          });
          check('session/resume 成功', true, { keys: Object.keys(resumed ?? {}) });

          updatesBySession.delete(candidate);
          const p = await ctx.request(acp.methods.agent.session.prompt, {
            sessionId: candidate,
            prompt: [{ type: 'text', text: '只回复一个词：resumed' }],
          });
          const routed = updatesBySession.get(candidate) ?? [];
          report.resume = { sessionId: candidate, stopReason: p?.stopReason, routedUpdates: routed };
          check('恢复后能继续对话（全局更新路由生效）', p?.stopReason === 'end_turn' && routed.length > 0, {
            stopReason: p?.stopReason,
            routedUpdates: routed.length,
          });
        } catch (e) {
          check('session/resume', false, String(e?.message ?? e));
        }
      }
      return report;
    });
  report.finishedAt = new Date().toISOString();
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  log(`\n❌ 失败: ${e?.message ?? e}`);
} finally {
  dsh.close();
}

const out = join(CAPTURE, `${new Date().toISOString().replace(/[:.]/g, '-')}-verify.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
log(`\n── 结论 ──`);
for (const c of report.checks) log(`${c.ok ? '✅' : '❌'}  ${c.name}`);
log(`\n产物: ${out}`);
log(`原始帧: ${dsh.framesPath}`);
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
