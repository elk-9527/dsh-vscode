'use strict';

/**
 * 「模式」（agent preset）的集成测试：启动真实内核，经由 ACP 接入点插件（dsh-acp-door）执行完整验证。
 *
 * 该套件单独设立的原因：预设不是 ACP 的概念，而是由该插件为内核接出的
 * （桌面端把工具改为「按会话挂载预设」，而 ACP 建立 agent 时不指定预设）。
 * 该链路横跨：客户端 `_meta` → 该插件拦截帧 → 内核 agentPresets.select() →
 * 该插件修改回复 → 客户端读出清单。任一段中断，面板上的「模式」下拉即无效。
 *
 * 该套件自行启动内核、自行回收，并自行选择一个空闲端口：
 * 不占用 47821，因此可与其他测试同时运行，也不受用户正在使用的 VS Code 影响。
 *
 * 运行方式：node test/presets.js
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { DoorClient, readDoorMeta } = require('../src/door/client');
const { ensureDoor, syncDoor, inspectDoor, PORT, PROFILE, TEST_PROFILE } = require('./helpers/door');

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

/** 由系统分配一个当前空闲的端口（取得后立即释放，随后使用）。 */
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
 * 生成一份「把该插件指向指定端口、并开启诊断日志」的覆盖文件。
 *
 * 采用 --patch 覆盖而不修改 profile 的原因：不得为运行测试而改动用户的档。
 * 覆盖是整体替换该插件的配置（实测：只写 port 会使 preset 被清除），
 * 因此此处写出全部需要的键 —— 尤其是 provider/model：缺少它们时会话可以建立，
 * 但发送消息即失败（内核原文 `agent "…" has no provider/model`），
 * 该测试将退化为「验证一个无法应答的模式」。
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

/** 读取诊断日志（由该插件写入，可确认内核侧是否成功挂载预设）。 */
function readDiag() {
  try {
    return fs.readFileSync(DIAG, 'utf8');
  } catch {
    return '';
  }
}

/** 清单项应仅包含以下字段 —— 内核内部字段不得暴露给客户端。 */
const ALLOWED_KEYS = ['id', 'name', 'description', 'order'];

/**
 * 从该插件自带的 bundle 补丁中读取 provider/model，不在此处另写一份固定值。
 *
 * 原因：生产环境中的该插件使用那份配置，此处若抄录错误或遗漏，测试会「通过」
 * 而生产环境无响应。该读取同时作为一项检查：那份补丁必须写明 provider/model
 * （缺少时会话可以建立但无法发送消息，该缺陷不易发现）。
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
    // 文件本就不存在，属正常情况。
  }

  const port = await freePort();
  const overlay = writeOverlay(port);
  console.log(`\n用 profile=${PROFILE}、端口 ${port}、覆盖文件 ${path.relative(ROOT, overlay)}`);
  console.log(`（这样无需占用 ${PORT}，也不会碰桌面端那一个）`);

  section('0. 前置：该插件自带的配置里必须写明 provider/model');
  check(
    '该插件补丁里有 provider',
    typeof PROVIDER === 'string' && PROVIDER.length > 0,
    JSON.stringify(PROVIDER),
  );
  check(
    '该插件补丁里有 model',
    typeof MODEL === 'string' && MODEL.length > 0,
    JSON.stringify(MODEL),
  );
  if (!PROVIDER || !MODEL) {
    console.log('  ❌ 缺了它们，经该插件建立的会话能建立却发不出消息（内核原文 agent has no provider/model）。');
    console.log('     先修 packages/dsh-door/cordis.patch.yml，再跑这个测试。');
    process.exit(1);
  }

  // 已安装的该插件必须与源码一致 —— 否则该套件测试的是旧代码（pnpm 对
  // `file:` 依赖存在缓存，修改源码后可能不会重新安装，实测已出现）。
  //
  // 仅测试档会自动重新安装。使用 `DSH_PANEL_PROFILE=desktop` 运行该套件
  // 是为了在生产档上验证真实路径；此时不得改动用户的档，
  // 只检查、只报告。（该规则来自实际经验：早期实现会向 desktop 安装，
  // 却按 dshdoor 的路径比对，导致生产档的依赖形态被改变。）
  if (PROFILE === TEST_PROFILE) {
    const sync = syncDoor({ log: (level, text) => console.log(`  [${level}] ${text}`) });
    check('测试档里装的该插件与源码一致（不一致时自动重新安装）', sync.drift.length === 0 || sync.synced, sync.drift.join('、'));
  } else {
    const info = inspectDoor(PROFILE);
    console.log(`  [info] 跑的是 ${PROFILE} 档：按规矩**不自动改**它，只检查`);
    check(`生产档 ${PROFILE} 里已安装该插件`, info.installed, info.path);
    if (info.installed) {
      console.log(`  [info] 装的是 ${info.version}；跟当前源码${info.drift.length ? `不一致（${info.drift.join('、')}）—— 源码比装的新，属于开发中的正常情况` : '逐字节一致'}`);
    }
  }

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
    check('已连接到自行启动的该插件', init && init.protocolVersion === 1, JSON.stringify(init));

    section('2. 不点名：使用该插件配置里的默认预设');
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
      '该插件的内核日志里有「挂预设成功 preset=minimal」',
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

    section('7. 真跑一个回合：极简模式下同样可调用工具（预设确实生效）');
    // 采用「回合中是否实际调用工具」作为证据，而不读取会话记录：
    // 实测确认，内核仅在桌面端的会话建立方式下才会把 agentPreset 写入
    // 会话记录；经 ACP 接入点插件建立的会话，记录中不含该字段（建立后读取、
    // 运行回合后读取均如此）。因此记录不能作为证据，行为可以。
    // 预设的意义在于「该会话可使用哪些工具」—— 极简模式同样包含 shell，
    // 因此必须能够调用工具。模型在无工具时会把工具调用作为文本输出
    // （`<｜｜DSML｜｜invoke …>`），该现象正是本检查要捕获的症状。
    const turn = await runTurn(client, minimal.sessionId, '用 shell 跑一下 echo dsh-door-minimal，把输出原样告我，别做别的。');
    check('极简模式下的回合跑通了', turn.ok, turn.error ?? '');
    check('回合里真的调了工具（不是只会说话）', turn.tools.length > 0, `工具调用 ${turn.tools.length} 次`);
    check(
      '没出现「把工具调用当文本写出来」的症状（没挂上预设才会这样）',
      !/DSML|invoke name=/i.test(turn.answer),
      turn.answer.trim().slice(0, 120),
    );

    section('8. 断线接回：预设要补回来，手不能丢（这里真出过 bug）');
    // 本条为回归保护措施。实测捕获的缺陷：resume 得到的会话不含任何工具，
    // 模型只能把工具调用作为文本输出。原因是恢复时 agent 的作用域被重新组装，
    // 而内核仅在会话记录中识别预设 —— 经该插件建立的会话记录中没有该字段（见第 7 节的说明）。
    // 该插件当前的做法是：select 被锁定时改用 mount()（工厂期的入口，不检查锁）。
    //
    // 此处故意复用第 7 节中已运行过回合的会话：只有运行过回合的会话，
    // select 才会被内核锁定，从而真正进入 mount 路径。刚建立且未发送消息的会话
    // 走的是 select，无法覆盖该缺陷（第一版即如此编写，测试通过但未验证任何内容）。
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
        '该插件用 mount 把预设补回去了',
        diagResume.includes(`恢复会话补挂预设成功（mount）会话=${resumeId}`),
        diagResume
          .split('\n')
          .filter((line) => line.includes('补挂'))
          .join(' | '),
      );
      check('没有出现补挂失败', !diagResume.includes('补挂预设失败'), diagResume.split('\n').filter((l) => l.includes('失败')).join(' | '));

      // 再次断开，此次不指定预设：该插件应依据自身记录（内核级记忆）补挂 minimal。
      // 单独验证的原因：该记忆若随连接一同丢失，重连会退回默认的
      // standard —— 用户会话的模式会被无提示地改变。
      client2.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mark = readDiag().length;
      const client3 = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
      await client3.connect();
      try {
        const again = await client3.resumeSession(resumeId, cwd);
        check('不点名时，该插件按自身记录补回的仍是 minimal', readDoorMeta(again)?.current === 'minimal', String(readDoorMeta(again)?.current));
        const diag3 = readDiag().slice(mark);
        check('日志里能看到它「记录」了这个会话的预设', diag3.includes('记录=minimal'), diag3.split('\n').filter((l) => l.includes('记录=')).join(' | '));
      } finally {
        client3.close();
      }
    } finally {
      client2.close();
    }
  } finally {
    if (client) client.close();
    // 仅回收自身启动的内核；若内核由其他进程启动，stop() 为空操作。
    door.stop();
    try {
      fs.unlinkSync(OVERLAY);
    } catch {
      // 删除失败不影响结果。
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
 * 运行一个回合，收集该时间段内的工具调用与正文。
 *
 * 直接监听 DoorClient 的原始事件、不封装一层 DshSession 的原因：本套件测试的是
 * 协议部分（ACP 接入点插件 dsh-acp-door），不应把面板层的解析一并纳入。ACP 的通知形状
 * 由内核定义：`session/update` 中的 `update.sessionUpdate` 为 `tool_call` /
 * `tool_call_update` / `agent_message_chunk`（与 DshSession 中的判断一致）。
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
  console.log(`\n❌ 测试自身发生异常：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
