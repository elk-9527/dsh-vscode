'use strict';

/**
 * 「权限」预设的集成测试：启动真实内核，经由 ACP 接入点插件（dsh-acp-door）依次切换四档。
 *
 * 单独设立该套件的原因：权限选择器不是 ACP 的概念（ACP 只暴露
 * 「模型」「推理强度」两个 config option，官方说明中明确表示不提供
 * DSH 专用 UI 这类内容），而由该插件 0.0.12 为内核接出。该链路横跨：
 * 面板 → 该插件 → 内核 `permissionPresets`（清单/当前值/切换）→ 会话的
 * `permissions` 投影 → 再回到面板。任一段中断，面板上的该选择器即无效。
 *
 * 该套件专门验证的两项内容：
 *
 *   1. 清单由内核提供，并非面板写死。 因此此处用 `--patch` 给内核增加
 *      一个 `auto-approval` 档（与用户档中 `dsh-auto-approval-plugin` 增加的档
 *      同名、同位置）—— 面板必须相应多出该项，且使用内核提供的
 *      「Auto Approval」名称，不得转换为其他名称。
 *   2. 切换确实作用于会话。 切换完成后重新向内核查询（不读取面板自身记录），
 *      且两段会话互不影响（权限属于每段会话）。
 *
 * 该套件自行启动内核、自行回收，端口由系统分配一个空闲值：不占用 47821，
 * 因此与用户正在使用的桌面端、以及其他套件均不冲突。
 *
 * 运行方式：node test/permission-live.js
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { DoorClient } = require('../src/door/client');
const { DOOR_CODES } = require('../src/dsh/permission.js');
const { ensureDoor, syncDoor, PORT, PROFILE, TEST_PROFILE } = require('./helpers/door');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIAG = path.join(BUILD, 'permission-diag.log');
const OVERLAY = path.join(BUILD, 'permission-overlay.yml');

/** 内核内置的三档（`@deepseek-ai/dsh-base` 的表），加上本机需要模拟的第四档。 */
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

/** 从该插件自带的 bundle 补丁中读取 provider/model（见 test/presets.js 的说明）。 */
function readDoorDefaults() {
  const text = fs.readFileSync(path.join(ROOT, '..', 'dsh-door', 'cordis.patch.yml'), 'utf8');
  const pick = (key) => {
    const hit = text.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'));
    return hit ? hit[1] : '';
  };
  return { provider: pick('provider'), model: pick('model') };
}

/**
 * 覆盖文件：把该插件指向测试端口，并将权限预设表按用户机器的配置写入。
 *
 * 权限表需要整份重述的原因：DSH 的 patch 会整体替换该行的 config，
 * 只写一项会清除其余档（用户档中 `dsh-auto-approval-plugin` 的注释也专门
 * 提示过该行为）。因此此处写出完整四档 —— 即用户机器上存在的四档。
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

/** 清单中包含哪些 value（按内核提供的顺序）。 */
function valuesOf(payload) {
  return Array.isArray(payload && payload.options) ? payload.options.map((item) => item.value) : [];
}

async function main() {
  console.log('DSH Panel · 「权限」预设集成测试（该插件 0.0.12 的旁路方法）');
  fs.mkdirSync(BUILD, { recursive: true });
  try {
    fs.unlinkSync(DIAG);
  } catch {
    // 文件本就不存在，属正常情况。
  }

  const defaults = readDoorDefaults();
  if (!defaults.provider || !defaults.model) {
    console.log('  ❌ 该插件补丁里缺 provider/model，先修 packages/dsh-door/cordis.patch.yml');
    process.exit(1);
  }

  const port = await freePort();
  const overlay = writeOverlay(port);
  console.log(`\n用 profile=${PROFILE}、端口 ${port}、覆盖文件 ${path.relative(ROOT, overlay)}`);
  console.log(`（这样无需占用 ${PORT}，也不会碰桌面端那一个）`);

  // 已安装的该插件必须与源码一致 —— 否则该套件测试的是旧代码（pnpm 对 `file:`
  // 依赖存在缓存，修改源码后可能不会重新安装）。仅改动测试档，见 helpers/door.js。
  if (PROFILE === TEST_PROFILE) {
    const sync = syncDoor({ log: (level, text) => console.log(`  [${level}] ${text}`) });
    check(
      '测试档里装的该插件与源码一致（不一致时自动重新安装）',
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
    check('已连接到自行启动的该插件', init && init.protocolVersion === 1, JSON.stringify(init));

    section('2. 建两段会话（权限是每段会话的事，得能对比）');
    const a = await client.newSession(cwd);
    const b = await client.newSession(cwd);
    check('两段都建起来了', Boolean(a?.sessionId) && Boolean(b?.sessionId));
    check('是两段不同的会话', a?.sessionId !== b?.sessionId);

    section('3. 读权限：清单来自内核（含插件加的那一档）');
    const stateA = await client.permissionGet(a.sessionId);
    const ids = valuesOf(stateA);
    check('该插件答得出权限状态（该插件 0.0.12 的方法在此处回话）', Array.isArray(stateA?.options), JSON.stringify(stateA));
    check(
      `清单就是内核配的那四档（不多不少）：${TABLE.join(' / ')}`,
      ids.join(',') === TABLE.join(','),
      ids.join(','),
    );
    check('当前值在清单里', ids.includes(stateA?.currentValue), String(stateA?.currentValue));
    /*
     * 新会话落在哪一档无法预先假定：`permission.defaultPreset` 属于用户设置
     * （本机为 `auto-approval`，写在同一份 `$DSH_HOME/settings.yaml` 中，
     * 桌面端「通用设置 → 权限」修改的即该项）。因此此处断言的是两者一致：
     * 内核报告的当前值即其报告的默认档，且该默认档存在于清单中。
     * 面板的职责是如实显示，不应替内核推测「应当为 workspace-write」。
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
    check('切回后同样生效', backToWrite?.currentValue === 'workspace-write', String(backToWrite?.currentValue));

    section('7. 切一个不存在的档：要明确报错，并且列出可用的');
    let badMessage = '';
    let badCode = 0;
    try {
      await client.permissionSet(a.sessionId, 'no-such-tier');
    } catch (error) {
      badMessage = String(error && error.message ? error.message : error);
      badCode = error && error.code;
    }
    check('报了错（不是静默成功）', badMessage.length > 0, badMessage);
    check('错误里点明了不存在的档名', /no-such-tier/.test(badMessage), badMessage);
    check('错误里列出了可用的档（用户/客户端能照着改）',
      /read-only/.test(badMessage) && /workspace-write/.test(badMessage),
      badMessage);
    /*
     * 错误码是本节需要固定下来的内容：客户端依据该码生成提示（`explainPermissionFailure` 先读码）。
     * 此前该情况与「会话找不到」同样返回 -32000，客户端只能依据中文原话推测 ——
     * 推测错误时「这个选项已经不在了」会被表述为「读不到当前权限，点重新连接再试一次」。
     */
    check('错误码是「名字不存在」那一档（不是笼统的 -32000）',
      badCode === DOOR_CODES.UNKNOWN_PRESET, String(badCode));

    section('7.5 把内核推导出来的 custom 当目标切：它不是一个能切的东西');
    let customCode = 0;
    let customMessage = '';
    try {
      await client.permissionSet(a.sessionId, 'custom');
    } catch (error) {
      customCode = error && error.code;
      customMessage = String(error && error.message ? error.message : error);
    }
    check('内核拒绝它（resolve() 直接抛）', customCode !== 0, customMessage);
    check('而且是「名字不存在」那一档 —— 面板据此把它渲染成灰的当前项、点了不发消息',
      customCode === DOOR_CODES.UNKNOWN_PRESET, String(customCode));
    const afterCustom = await client.permissionGet(a.sessionId);
    check('切失败之后状态没变', afterCustom?.currentValue === 'workspace-write',
      String(afterCustom?.currentValue));
    const afterBad = await client.permissionGet(a.sessionId);
    check('切失败之后状态没变（还是前面那个档）',
      afterBad?.currentValue === 'workspace-write', String(afterBad?.currentValue));

    section('8. 不存在的会话：要说清楚，而不是内部异常');
    let missingMessage = '';
    let missingCode = 0;
    try {
      await client.permissionGet('session-does-not-exist-7c1f');
    } catch (error) {
      missingMessage = String(error && error.message ? error.message : error);
      missingCode = error && error.code;
    }
    check('报了错', missingMessage.length > 0, missingMessage);
    check('说的是「这个内核里没有这段会话」（人话）',
      /没有会话|没有这段|no session/i.test(missingMessage), missingMessage);
    check('错误码是「会话不存在」那一档（跟名字不存在分开）',
      missingCode === DOOR_CODES.NO_SESSION, String(missingCode));

    section('9. 请求的方法名不在该插件的清单里时也能给出清晰说明');
    let unknownMethod = '';
    try {
      await client.request('dsh-door/permission/nope', { id: a.sessionId });
    } catch (error) {
      unknownMethod = String(error && error.message ? error.message : error);
    }
    check('答的是「方法名无法识别」，不是内核的 Method not found',
      /不认识权限方法/.test(unknownMethod), unknownMethod);

    const diag = readDiag();
    check('该插件的诊断日志里留下了这几次应答（排障要看它）',
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
  console.error('💥 测试发生异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
