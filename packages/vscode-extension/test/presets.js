'use strict';

/**
 * 「模式」（agent preset）的集成测试：起一个真内核，走真的门，验到底。
 *
 * 为什么值得单独一个套件：预设不是 ACP 的概念，是门替内核接出来的
 * （桌面端把工具改成「按会话挂预设」，而 ACP 建 agent 时从不点名预设）。
 * 这条链路横跨：客户端 `_meta` → 门拦帧 → 内核 agentPresets.select() →
 * 门改回复 → 客户端读出清单。任何一段断了，面板上的「模式」下拉就是假的。
 *
 * 这个套件**自己起内核、自己收**，而且自己挑一个空闲端口：
 * 不去抢 47821，所以它可以和别的测试同时存在，也不受你正开着的 VS Code 影响。
 *
 * 跑法：node test/presets.js
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { DoorClient, readDoorMeta } = require('../src/door/client');
const { ensureDoor, syncDoor } = require('./helpers/door');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIAG = path.join(BUILD, 'presets-diag.log');
const OVERLAY = path.join(BUILD, 'presets-overlay.yml');

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n── ${title} ──`);
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  }
}

/** 让系统给一个当前空闲的端口（拿到就立刻放掉，紧接着用）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 写一份「把门指到指定端口、并打开诊断日志」的覆盖文件。
 *
 * 为什么用 --patch 覆盖而不是改 profile：不能为了跑测试去动用户的档。
 * 注意覆盖是**整体替换**门那份配置（实测：只写 port 会把 preset 冲掉），
 * 所以这里把要用的键全写齐 —— 尤其是 provider/model：缺了它们，会话能建起来
 * 但一发消息就失败（内核原文 `agent "…" has no provider/model`），
 * 那这个测试就会变成「验证一个不能说话的模式」。
 */
function writeOverlay(port) {
  fs.mkdirSync(BUILD, { recursive: true });
  const yaml = [
    '# 测试自动生成，别手改（test/presets.js）',
    '- id: acp-door',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    `    provider: ${PROVIDER}`,
    `    model: ${MODEL}`,
    '    preset: standard',
    `    diagLog: '${DIAG}'`,
    '',
  ].join('\n');
  fs.writeFileSync(OVERLAY, yaml, 'utf8');
  return OVERLAY;
}

/** 读诊断日志（门写的，能看见内核侧到底挂没挂上预设）。 */
function readDiag() {
  try {
    return fs.readFileSync(DIAG, 'utf8');
  } catch {
    return '';
  }
}

/** 清单项只该有这几个字段 —— 内核内部字段不许漏给客户端。 */
const ALLOWED_KEYS = ['id', 'name', 'description', 'order'];

/**
 * 从门自带的 bundle 补丁里读 provider/model，而不是在这里再写死一份。
 *
 * 为什么：生产上的门用的是那份配置，这里要是抄错或抄漏，测试就会「通过」
 * 而生产是哑的。顺便也当成一条检查：那份补丁必须写明 provider/model
 * （缺了的话会话建得起来却发不出消息，是个很隐蔽的坑）。
 */
function readDoorDefaults() {
  const file = path.join(ROOT, '..', 'dsh-door', 'cordis.patch.yml');
  const text = fs.readFileSync(file, 'utf8');
  const pick = (key) => {
    const hit = text.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'));
    return hit ? hit[1] : '';
  };
  return { provider: pick('provider'), model: pick('model') };
}

const DOOR_DEFAULTS = readDoorDefaults();
const PROVIDER = DOOR_DEFAULTS.provider;
const MODEL = DOOR_DEFAULTS.model;

async function main() {
  console.log('DSH Panel · 「模式」（agent preset）集成测试');
  fs.mkdirSync(BUILD, { recursive: true });
  try {
    fs.unlinkSync(DIAG);
  } catch {
    // 本来就没有，正常。
  }

  const port = await freePort();
  const overlay = writeOverlay(port);
  console.log(`\n用 profile=dshdoor、端口 ${port}、覆盖文件 ${path.relative(ROOT, overlay)}`);
  console.log('（这样不用去抢 47821，也不会碰你桌面上那一个）');

  section('0. 前置：门自带的配置里必须写明 provider/model');
  check(
    '门补丁里有 provider',
    typeof PROVIDER === 'string' && PROVIDER.length > 0,
    JSON.stringify(PROVIDER),
  );
  check(
    '门补丁里有 model',
    typeof MODEL === 'string' && MODEL.length > 0,
    JSON.stringify(MODEL),
  );
  if (!PROVIDER || !MODEL) {
    console.log('  ❌ 缺了它们，走门的会话能建起来却发不出消息（内核原文 agent has no provider/model）。');
    console.log('     先修 packages/dsh-door/cordis.patch.yml，再跑这个测试。');
    process.exit(1);
  }

  // 装的那份门必须跟源码一致 —— 否则这个套件就是在测旧代码（pnpm 对
  // `file:` 依赖有缓存，改了源码它可能压根不重装，实测踩过）。
  const sync = syncDoor({ log: (level, text) => console.log(`  [${level}] ${text}`) });
  check('测试档里装的门跟源码一致（不一致会自动重装）', sync.drift.length === 0 || sync.synced, sync.drift.join('、'));

  const door = await ensureDoor({
    port,
    extraArgs: ['--patch', overlay],
    log: (level, message) => console.log(`  [${level}] ${message}`),
  });

  const cwd = ROOT;
  let client;
  try {
    section('1. 握手');
    client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    const init = await client.connect();
    check('连上了自己起的门', init && init.protocolVersion === 1, JSON.stringify(init));

    section('2. 不点名：用门配置里的默认预设');
    const plain = await client.newSession(cwd);
    const plainMeta = readDoorMeta(plain);
    check('回复里带了预设清单', Array.isArray(plainMeta?.presets), JSON.stringify(plainMeta));
    check('默认预设是 standard', plainMeta?.current === 'standard', String(plainMeta?.current));
    check('没点名就不该有 requested', plainMeta?.requested === undefined, String(plainMeta?.requested));
    check('没点名就没发生退回', !plainMeta?.fallback, String(plainMeta?.fallback));

    section('3. 清单：内核里有什么，客户端就看见什么');
    const presets = plainMeta?.presets ?? [];
    const ids = presets.map((item) => item.id);
    check('至少 4 个预设', presets.length >= 4, `${presets.length} 个：${ids.join(', ')}`);
    for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
      check(`清单里有 ${id}`, ids.includes(id), ids.join(', '));
    }
    const named = presets.filter((item) => item.id === 'standard')[0];
    check('带中文名（内核 preset.yml 里的）', Boolean(named?.name), JSON.stringify(named));
    check(
      '带说明文字',
      typeof named?.description === 'string' && named.description.length > 0,
      JSON.stringify(named?.description),
    );
    check(
      '没有漏出内核内部字段',
      presets.every((item) => Object.keys(item).every((key) => ALLOWED_KEYS.includes(key))),
      JSON.stringify(presets.map((item) => Object.keys(item))),
    );

    section('4. 点名 minimal（极简模式）');
    const minimal = await client.newSession(cwd, { preset: 'minimal' });
    const minimalMeta = readDoorMeta(minimal);
    check('current 就是点名的那个', minimalMeta?.current === 'minimal', String(minimalMeta?.current));
    check('requested 如实回报', minimalMeta?.requested === 'minimal', String(minimalMeta?.requested));
    check('没有发生退回', !minimalMeta?.fallback, String(minimalMeta?.fallback));
    check('拿到了 sessionId', typeof minimal?.sessionId === 'string' && minimal.sessionId.length > 0);
    const diagAfterMinimal = readDiag();
    check(
      '门的内核日志里有「挂预设成功 preset=minimal」',
      diagAfterMinimal.includes(`挂预设成功（select）会话=${minimal.sessionId} preset=minimal`),
      diagAfterMinimal
        .split('\n')
        .filter((line) => line.includes('挂预设'))
        .slice(-3)
        .join(' | '),
    );

    section('5. 连续两次不同预设：不会串台');
    const p1 = await client.newSession(cwd, { preset: 'cordis' });
    const p2 = await client.newSession(cwd, { preset: 'ptc' });
    check('第一段是 cordis', readDoorMeta(p1)?.current === 'cordis', String(readDoorMeta(p1)?.current));
    check('第二段是 ptc', readDoorMeta(p2)?.current === 'ptc', String(readDoorMeta(p2)?.current));
    check('两段是不同的会话', p1.sessionId !== p2.sessionId);

    section('6. 点了个不存在的预设：明确退回默认，并且如实告诉客户端');
    const bogus = await client.newSession(cwd, { preset: 'no-such-preset' });
    const bogusMeta = readDoorMeta(bogus);
    check('实际用的是默认 standard', bogusMeta?.current === 'standard', String(bogusMeta?.current));
    check('如实回报客户端点名的是什么', bogusMeta?.requested === 'no-such-preset', String(bogusMeta?.requested));
    check('明确标了「退回了」', bogusMeta?.fallback === true, String(bogusMeta?.fallback));
    check('会话本身照常建起来了', typeof bogus?.sessionId === 'string' && bogus.sessionId.length > 0);
    const diagAll = readDiag();
    check(
      '内核日志里记了这件事',
      diagAll.includes('不在清单里'),
      diagAll.split('\n').filter((line) => line.includes('不在清单里')).slice(-1).join(''),
    );
    check('没有把不存在的预设当成成功挂上去', !diagAll.includes('preset=no-such-preset'));

    section('7. 真跑一个回合：极简模式下它照样有手（预设真的生效了）');
    // 为什么用「回合里有没有真调工具」当证据，而不是去读会话记录：
    // 实测确认，内核只在**桌面端那种建会话方式**下才把 agentPreset 写进
    // 会话记录；走 ACP 门建的会话，记录里根本没有这个字段（建完就读、
    // 跑完回合再读都没有）。所以记录当不了证据，行为才能。
    // 而预设的整个意义就是「这个会话手里有哪些工具」—— 极简模式也带 shell，
    // 所以它必须能调工具。模型在没有工具时会**把工具调用当文本写出来**
    // （`<｜｜DSML｜｜invoke …>`），那正是这个检查要抓的症状。
    const turn = await runTurn(client, minimal.sessionId, '用 shell 跑一下 echo dsh-door-minimal，把输出原样告我，别做别的。');
    check('极简模式下的回合跑通了', turn.ok, turn.error ?? '');
    check('回合里真的调了工具（不是只会说话）', turn.tools.length > 0, `工具调用 ${turn.tools.length} 次`);
    check(
      '没出现「把工具调用当文本写出来」的症状（没挂上预设才会这样）',
      !/DSML|invoke name=/i.test(turn.answer),
      turn.answer.trim().slice(0, 120),
    );

    section('8. 断线接回：预设要补回来，手不能丢（这里真出过 bug）');
    // 这条是回归护栏。实测抓到过的真 bug：resume 出来的会话**一个工具都没有**，
    // 模型只能把工具调用当文本写出来。原因是恢复时 agent 的作用域是重新组装的，
    // 而内核只在会话记录里认预设 —— 走门建的会话记录里没有（见第 7 节的说明）。
    // 门现在的做法是：select 被锁就改用 mount()（工厂期那个入口，不看锁）。
    //
    // 故意复用第 7 节那段**已经跑过回合**的会话：只有跑过回合的会话，
    // select 才会被内核锁住，从而真正走到 mount 那条路。刚建好没说过话的会话
    // 走的是 select，测不到这个 bug（第一版就是这么写的，绿得毫无意义）。
    const resumeId = minimal.sessionId;
    const diagBeforeResume = readDiag().length;
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const client2 = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    await client2.connect();
    try {
      const back = await client2.resumeSession(resumeId, cwd, { preset: 'minimal' });
      const meta = readDoorMeta(back);
      check('接回来的回复里也带着预设清单', Array.isArray(meta?.presets) && meta.presets.length > 0);
      check('接回来的当前预设还是 minimal', meta?.current === 'minimal', String(meta?.current));
      const diagResume = readDiag().slice(diagBeforeResume);
      check(
        '门用 mount 把预设补回去了',
        diagResume.includes(`恢复会话补挂预设成功（mount）会话=${resumeId}`),
        diagResume
          .split('\n')
          .filter((line) => line.includes('补挂'))
          .join(' | '),
      );
      check('没有出现补挂失败', !diagResume.includes('补挂预设失败'), diagResume.split('\n').filter((l) => l.includes('失败')).join(' | '));

      // 再断一次，这次**不点名**预设：门应该凭自己记得的（内核级记忆）补挂 minimal。
      // 为什么要单独验：这份记忆要是跟着连接一起丢了，重连就会退回默认的
      // standard —— 用户的会话会莫名其妙换模式。
      client2.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mark = readDiag().length;
      const client3 = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
      await client3.connect();
      try {
        const again = await client3.resumeSession(resumeId, cwd);
        check('不点名时，门凭记忆补的还是 minimal', readDoorMeta(again)?.current === 'minimal', String(readDoorMeta(again)?.current));
        const diag3 = readDiag().slice(mark);
        check('日志里能看到它「记得」这个会话的预设', diag3.includes('记得=minimal'), diag3.split('\n').filter((l) => l.includes('记得=')).join(' | '));
      } finally {
        client3.close();
      }
    } finally {
      client2.close();
    }
  } finally {
    if (client) client.close();
    // 只收自己拉起来的那个内核；本来就是别人开着的，stop() 是空操作。
    door.stop();
    try {
      fs.unlinkSync(OVERLAY);
    } catch {
      // 删不掉也不影响结果。
    }
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) {
    console.log(`✅ 全部通过：${passed} 项检查`);
    process.exit(0);
  }
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(1);
}

/**
 * 跑一个回合，把这段时间里的工具调用与正文都收下来。
 *
 * 为什么直接听 DoorClient 的原始事件、而不套一层 DshSession：本套件测的是
 * **门**（协议那一段），不该把面板那一层的解析也拉进来背锅。ACP 的通知形状
 * 是内核定的：`session/update` 里 `update.sessionUpdate` 是 `tool_call` /
 * `tool_call_update` / `agent_message_chunk`（跟 DshSession 里的判断一致）。
 *
 * @returns {Promise<{ok: boolean, tools: object[], answer: string, error?: string}>}
 */
async function runTurn(client, sessionId, text) {
  const tools = [];
  let answer = '';
  const onUpdate = (_sessionId, update) => {
    const kind = update && update.sessionUpdate;
    if (kind === 'tool_call' || kind === 'tool_call_update') tools.push(update);
    if (kind === 'agent_message_chunk') {
      const content = update.content;
      if (content && typeof content.text === 'string') answer += content.text;
    }
  };
  client.on('update', onUpdate);
  try {
    await client.prompt(sessionId, text);
    return { ok: true, tools, answer };
  } catch (error) {
    return { ok: false, tools, answer, error: error && error.message };
  } finally {
    client.off('update', onUpdate);
  }
}

main().catch((error) => {
  console.log(`\n❌ 测试自己崩了：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
