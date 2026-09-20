'use strict';

/**
 * 「命令路径中包含空格」这一路径的真实进程测试。
 *
 * ── 单独设立该套件的原因 ─────────────────────────────────────────
 * 2026-09-19 修复的缺陷包含两个部分，两部分均只在真实进程中暴露：
 *
 *   1. `splitCommand()` 按空白硬分割，把 `…\DSH Desktop\…\dsh.cmd` 拆成两段；
 *   2. `spawn(cmd.exe, ['/d','/s','/c', '"…"'])` 会对内嵌引号再次转义，
 *      因此"由用户自行添加引号"这一路径同样失效（必须设置 windowsVerbatimArguments）。
 *
 * 两部分的共同点是：拼接出的字符串表面上完全正确。因此仅测试
 * `commandLine()` 的返回值无法覆盖它们 —— 必须真实启动进程，
 * 确认其是否实际执行。（路径被拆分时 cmd 的原话为
 * `'C:\Users\…\Roaming\DSH' is not recognized as an internal or external command`。）
 *
 * 这也说明该套件的必要性：本机 dsh 的真实路径即包含空格
 * （`…\AppData\Roaming\DSH Desktop\host-commands\…\dsh.cmd`），
 * 因此这不属于"某个用户的环境问题"，而是该机器上必然出现的情况。
 *
 * 方法：生成一个 .cmd 垫片（内容为把接收到的参数写入 out.txt），
 * 使用真实的 `spawnBackgroundDsh` / `runDshSync` 执行它，再读取 out.txt 比对内容。
 * 不依赖 dsh、不依赖内核、不占用端口，数秒内完成。
 *
 * 运行方式：node test/spawn-quote.js
 * （非 Windows 上退出码 2 = 环境不满足，该命令行缺陷仅存在于 Windows）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  commandLine,
  resolveCommand,
  runDshSync,
  spawnBackgroundDsh,
  splitCommand,
  stripOuterQuotes,
} = require('../src/door/locate');

let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n── ${title} ──`);
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

function equal(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? undefined : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

if (process.platform !== 'win32') {
  console.log('非 Windows：这条命令行拼法的坑只存在于 Windows，跳过（不算失败）。');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 使用系统临时目录，不使用仓库中的 build/ —— 该目录会被打包脚本清空，
  // 且不纳入版本控制。测试的现场文件应放在临时目录中，运行结束后自行删除。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-'));
  const spacedDir = path.join(root, 'probe space');   // 路径含空格 —— 主要测试对象
  const plainDir = path.join(root, 'probe-plain');    // 路径不含空格 —— 对照组
  fs.mkdirSync(spacedDir, { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });

  // 垫片：把接收到的全部参数写入同目录下的 out.txt（%~dp0 = 脚本所在目录）。
  const body = '@echo off\r\necho %* > "%~dp0out.txt"\r\n';
  const spacedCmd = path.join(spacedDir, 'hello.cmd');
  const plainCmd = path.join(plainDir, 'hello.cmd');
  fs.writeFileSync(spacedCmd, body);
  fs.writeFileSync(plainCmd, body);
  const spacedOut = path.join(spacedDir, 'out.txt');
  const plainOut = path.join(plainDir, 'out.txt');
  const resetOut = (file) => { try { fs.unlinkSync(file); } catch { /* 文件本就不存在 */ } };
  const outText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');

  const log = () => {};

  try {
    section('1. 拆命令：不能把带空格的路径劈开');
    equal('直接给出带空格路径 → 整段作为程序名', resolveCommand(spacedCmd), [spacedCmd]);
    equal('带空格的路径 + 自带参数 → 程序名粘回去，参数分开',
      resolveCommand(`${spacedCmd} --profile desktop`), [spacedCmd, '--profile', 'desktop']);
    equal('`node <带空格的脚本>` → 脚本路径粘回一个参数',
      resolveCommand(`node ${spacedCmd} extra`), ['node', spacedCmd, 'extra']);
    equal('整体加引号 → 剥掉引号还是整段',
      resolveCommand(`"${spacedCmd}" --profile desktop`), [spacedCmd, '--profile', 'desktop']);
    equal('不带空格的路径照旧', resolveCommand(plainCmd), [plainCmd]);
    equal('纯命令名照旧按空白拆', splitCommand('dsh --profile desktop'), ['dsh', '--profile', 'desktop']);
    equal('stripOuterQuotes 只剥最外层', stripOuterQuotes(`"${spacedCmd}"`), spacedCmd);

    // 本条是「不得过度拼接」的反向证据：磁盘上不存在任何匹配的前缀时，
    // 不得把参数拼接起来（拼接的依据是磁盘上确实存在该文件，而非推测）。
    equal('不存在的东西不许乱粘',
      resolveCommand('dsh --profile desktop'), ['dsh', '--profile', 'desktop']);

    equal('拼出来的命令行：程序名整段加引号',
      commandLine(spacedCmd, ['--profile', 'desktop']), `"${spacedCmd}" --profile desktop`);

    section('2. 真进程：后台拉起（三种写法都必须跑起来）');
    for (const [label, command] of [
      ['A. 直接给出带空格路径', spacedCmd],
      ['B. 带空格的路径加引号', `"${spacedCmd}"`],
      ['C. 带空格的路径 + 自带参数', `${spacedCmd} 自带参数`],
    ]) {
      resetOut(spacedOut);
      const bg = spawnBackgroundDsh({ command, profile: 'desktop', log });
      await wait(1000);
      const text = outText(spacedOut);
      bg.dispose();
      await wait(200);
      check(label, text.length > 0, text ? `垫片收到：${text}` : '垫片根本没跑（out.txt 没生成）');
    }

    section('3. 对照组：路径不带空格（原本正常，不得改坏）');
    resetOut(plainOut);
    const bgPlain = spawnBackgroundDsh({ command: plainCmd, profile: 'desktop', log });
    await wait(1000);
    const plainText = outText(plainOut);
    bgPlain.dispose();
    await wait(200);
    check('D. 不带空格的路径', plainText.length > 0, plainText || '垫片没跑');

    section('4. runDshSync（测试安装该插件走的即为这条路）');
    resetOut(spacedOut);
    try {
      runDshSync({ command: spacedCmd, args: ['sync-arg'], timeoutMs: 15000 });
      const text = outText(spacedOut);
      check('E. 带空格的路径 + 参数', text.includes('sync-arg'), text || 'out.txt 没生成');
    } catch (error) {
      check('E. 带空格的路径 + 参数', false, String(error.message).split('\n')[0]);
    }

    section('5. 参数真的原样到达（没有被多转义/少转义）');
    resetOut(spacedOut);
    const bgArgs = spawnBackgroundDsh({
      command: spacedCmd,
      profile: 'desktop',
      log,
      extraArgs: ['--patch', path.join(spacedDir, 'a b.yml')],
    });
    await wait(1000);
    const argText = outText(spacedOut);
    bgArgs.dispose();
    await wait(200);
    check('带空格的参数原样到达', argText.includes('--patch') && argText.includes('a b.yml'), argText);
    check('profile 名也在（顺带证明参数是按顺序传的）', argText.includes('--profile desktop'), argText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项检查`);
    process.exit(0);
  }
  console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const label of failures) console.log(`   - ${label}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`测试自身发生异常：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
