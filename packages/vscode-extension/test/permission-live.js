'use strict';

/**
 * 「权限」预设的集成测试：起一个真内核、走真的门，把四档都切一遍。
 *
 * 为什么值得单独一个套件：权限选择器**不是 ACP 的概念**（ACP 只暴露
 * 「模型」「推理强度」两个 config option，官方说明里写明它刻意不提供
 * DSH 专用 UI 那类东西），是门 0.0.12 替内核接出来的。这条链路横跨：
 * 面板 → 门 → 内核 `permissionPresets`（清单/当前值/切换）→ 会话的
 * `permissions` 投影 → 再回面板。任何一段断了，面板上那个选择器就是假的。
 *
 * 两件这个套件专门要证明的事：
 *
 *   1. **清单是内核给的，不是面板写死的。** 所以这里用 `--patch` 给内核加了
 *      一个 `auto-approval` 档（跟用户档里 `dsh-auto-approval-plugin` 加的那一档
 *      同一个名字、同一个位置）—— 面板必须跟着多出来，而且用内核给的
 *      「Auto Approval」这个名字，不许翻译成别的东西。
 *   2. **切换真的落到会话上。** 切完重新问内核（不是看面板自己记的），
 *      而且**两段会话互不影响**（权限是每段会话的事）。
 *
 * 这个套件**自己起内核、自己收**，端口让系统给一个空闲的：不去抢 47821，
 * 所以它跟你正开着的桌面端、跟别的套件都不冲突。
 *
 * 跑法：node test/permission-live.js
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { DoorClient } = require('../src/door/client');
const { ensureDoor, syncDoor, PORT, PROFILE, TEST_PROFILE } = require('./helpers/door');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIAG = path.join(BUILD, 'permission-diag.log');
const OVERLAY = path.join(BUILD, 'permission-overlay.yml');

/** 内核内置那三档（`@deepseek-ai/dsh-base` 的表），加这台上要模拟的第四档。 */
const TABLE = ['read-only', 'workspace-write', 'auto-approval', 'danger-full-access'];

let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n── ${title} ──`);
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`);
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

/** 从门自带的 bundle 补丁里读 provider/model（见 test/presets.js 的说明）。 */
function readDoorDefaults() {
  const text = fs.readFileSync(path.join(ROOT, '..', 'dsh-door', 'cordis.patch.yml'), 'utf8');
  const pick = (key) => {
    const hit = text.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'));
    return hit ? hit[1] : '';
  };
  return { provider: pick('provider'), model: pick('model') };
}

/**
 * 覆盖文件：门指到测试端口 + **权限预设表按用户那台的样子配**。
 *
 * 为什么权限那张表要整份重述：DSH 的 patch 是**整体替换**那一行的 config，
 * 只写一项会把其余档冲掉（用户档里 `dsh-auto-approval-plugin` 的注释也专门
 * 提醒过这件事）。所以这里把四档写全 —— 正好也就是用户那台上有的四档。
 */
function writeOverlay(port) {
  fs.mkdirSync(BUILD, { recursive: true });
  const { provider, model } = readDoorDefaults();
  const yaml = [
    '# 测试自动生成，别手改（test/permission-live.js）',
    '- id: acp-door',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    `    provider: ${provider}`,
    `    model: ${model}`,
    '    preset: standard',
    `    diagLog: '${DIAG}'`,
    '',
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      auto-approval:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '        name: Auto Approval',
    '        description: Workspace writes, plus automatic approval of harmless commands.',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '    defaultPreset: workspace-write',
    '',
  ].join('\n');
  fs.writeFileSync(OVERLAY, yaml, 'utf8');
  return OVERLAY;
}

function readDiag() {
  try {
    return fs.readFileSync(DIAG, 'utf8');
  } catch {
    return '';
  }
}

/** 清单里都有哪些 value（按内核给的顺序）。 */
function valuesOf(payload) {
  return Array.isArray(payload && payload.options) ? payload.options.map((item) => item.value) : [];
}

async function main() {
  console.log('DSH Panel · 「权限」预设集成测试（门 0.0.12 的旁路方法）');
  fs.mkdirSync(BUILD, { recursive: true });
  try {
    fs.unlinkSync(DIAG);
  } catch {
    // 本来就没有，正常。
  }

  const defaults = readDoorDefaults();
  if (!defaults.provider || !defaults.model) {
    console.log('  ❌ 门补丁里缺 provider/model，先修 packages/dsh-door/cordis.patch.yml');
    process.exit(1);
  }

  const port = await freePort();
  const overlay = writeOverlay(port);
  console.log(`\n用 profile=${PROFILE}、端口 ${port}、覆盖文件 ${path.relative(ROOT, overlay)}`);
  console.log(`（这样不用去抢 ${PORT}，也不会碰你桌面上那一个）`);

  // 装的门必须跟源码一致 —— 否则这个套件就是在测旧代码（pnpm 对 `file:`
  // 依赖有缓存，改了源码它可能压根不重装）。只动测试档，见 helpers/door.js。
  if (PROFILE === TEST_PROFILE) {
    const sync = syncDoor({ log: (level, text) => console.log(`  [${level}] ${text}`) });
    check(
      '测试档里装的门跟源码一致（不一致会自动重装）',
      sync.drift.length === 0 || sync.synced,
      sync.drift.join('、'),
    );
  } else {
    console.log(`  [info] 跑的是 ${PROFILE} 档：按规矩不自动改它，只检查`);
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
    check('连上了自己起的门', init && init.protocolVersion === 1, JSON.stringify(init));

    section('2. 建两段会话（权限是每段会话的事，得能对比）');
    const a = await client.newSession(cwd);
    const b = await client.newSession(cwd);
    check('两段都建起来了', Boolean(a?.sessionId) && Boolean(b?.sessionId));
    check('是两段不同的会话', a?.sessionId !== b?.sessionId);

    section('3. 读权限：清单来自内核（含插件加的那一档）');
    const stateA = await client.permissionGet(a.sessionId);
    const ids = valuesOf(stateA);
    check('门答得出权限状态（门 0.0.12 的方法在这儿回话了）', Array.isArray(stateA?.options), JSON.stringify(stateA));
    check(
      `清单就是内核配的那四档（不多不少）：${TABLE.join(' / ')}`,
      ids.join(',') === TABLE.join(','),
      ids.join(','),
    );
    check('当前值在清单里', ids.includes(stateA?.currentValue), String(stateA?.currentValue));
    /*
     * 新会话落在哪一档**不能假设**：`permission.defaultPreset` 是用户设置
     * （这台机器上是 `auto-approval`，写在同一份 `$DSH_HOME/settings.yaml` 里，
     * 桌面端「通用设置 → 权限」改的就是它）。所以这里断言的是**一致性**：
     * 内核报的当前值就是它报的默认档，而且那个默认档在清单里。
     * 面板的活是照实显示，不是替内核猜一个「应该是 workspace-write」。
     */
    check('新会话落在内核的默认档上（默认值来自用户设置，不是写死的）',
      !stateA?.defaultPreset || stateA.currentValue === stateA.defaultPreset,
      `当前=${stateA?.currentValue} 默认=${stateA?.defaultPreset}`);
    check('顺带报了「新会话的默认档」，而且它在清单里',
      !stateA?.defaultPreset || ids.includes(stateA.defaultPreset),
      `默认=${stateA?.defaultPreset} 清单=${ids.join(',')}`);
    if (stateA?.defaultPreset) {
      console.log(`     这台机器上 settings.yaml 的 permission.defaultPreset = ${stateA.defaultPreset}`);
    }
    const auto = (stateA.options || []).find((item) => item.value === 'auto-approval');
    check('插件加的那一档带的是内核给的名字 Auto Approval（没人替它改名）',
      auto?.name === 'Auto Approval', JSON.stringify(auto));

    section('4. 切一档，内核回读要真的变');
    const afterReadOnly = await client.permissionSet(a.sessionId, 'read-only');
    check('切完的回复里当前值就是 read-only', afterReadOnly?.currentValue === 'read-only', String(afterReadOnly?.currentValue));
    const reRead = await client.permissionGet(a.sessionId);
    check('重新问一次内核，它也说 read-only（不是客户端自己记的）',
      reRead?.currentValue === 'read-only', String(reRead?.currentValue));

    section('5. 权限是每段会话的：另一段不受影响');
    const stateB = await client.permissionGet(b.sessionId);
    check('另一段还是它建出来时的那个档（没被 A 的切换带跑）',
      stateB?.currentValue === stateA?.currentValue,
      `B=${stateB?.currentValue} A 建出来时=${stateA?.currentValue}`);
    check('另一段确实没变成 read-only', stateB?.currentValue !== 'read-only', String(stateB?.currentValue));

    section('6. 切到最宽那档（完全权限）');
    const full = await client.permissionSet(a.sessionId, 'danger-full-access');
    check('内核接受了，并如实回报', full?.currentValue === 'danger-full-access', String(full?.currentValue));
    const backToWrite = await client.permissionSet(a.sessionId, 'workspace-write');
    check('切回去也照样生效', backToWrite?.currentValue === 'workspace-write', String(backToWrite?.currentValue));

    section('7. 切一个不存在的档：要明确报错，并且列出可用的');
    let badMessage = '';
    try {
      await client.permissionSet(a.sessionId, 'no-such-tier');
    } catch (error) {
      badMessage = String(error && error.message ? error.message : error);
    }
    check('报了错（不是静默成功）', badMessage.length > 0, badMessage);
    check('错误里点明了不认识的档名', /no-such-tier/.test(badMessage), badMessage);
    check('错误里列出了可用的档（用户/客户端能照着改）',
      /read-only/.test(badMessage) && /workspace-write/.test(badMessage),
      badMessage);
    const afterBad = await client.permissionGet(a.sessionId);
    check('切失败之后状态没变（还是前面那个档）',
      afterBad?.currentValue === 'workspace-write', String(afterBad?.currentValue));

    section('8. 不存在的会话：要说清楚，而不是内部异常');
    let missingMessage = '';
    try {
      await client.permissionGet('session-does-not-exist-7c1f');
    } catch (error) {
      missingMessage = String(error && error.message ? error.message : error);
    }
    check('报了错', missingMessage.length > 0, missingMessage);
    check('说的是「这个内核里没有这段会话」（人话）',
      /没有会话|没有这段|no session/i.test(missingMessage), missingMessage);

    section('9. 门自己的方法名不认识时也照样答得清清楚楚');
    let unknownMethod = '';
    try {
      await client.request('dsh-door/permission/nope', { id: a.sessionId });
    } catch (error) {
      unknownMethod = String(error && error.message ? error.message : error);
    }
    check('答的是「门不认识这个方法」，不是内核的 Method not found',
      /门不认识权限方法/.test(unknownMethod), unknownMethod);

    const diag = readDiag();
    check('门的诊断日志里留下了这几次应答（排障要看它）',
      /旁路应答权限/.test(diag),
      diag.split('\n').filter((line) => line.includes('权限')).slice(-3).join(' | '));
  } finally {
    if (client) client.close();
    door.stop();
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('💥 测试崩了：', error && error.stack ? error.stack : error);
  process.exit(1);
});
