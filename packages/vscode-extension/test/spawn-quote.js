'use strict';

/**
 * 「命令路径里有空格」这条路的真进程测试。
 *
 * ── 为什么单独一个套件 ────────────────────────────────────────────
 * 2026-09-19 修掉的那个 bug 有两半，**两半都只在真进程里才暴露**：
 *
 *   1. `splitCommand()` 按空白硬拆，把 `…\DSH Desktop\…\dsh.cmd` 劈成两段；
 *   2. `spawn(cmd.exe, ['/d','/s','/c', '"…"'])` 会把内嵌的引号**再转义一遍**，
 *      于是"用户自己加引号"这条路也是坏的（必须给 windowsVerbatimArguments）。
 *
 * 这两半的共同点是：**拼出来的字符串看起来完全正确**。所以只测
 * `commandLine()` 的返回值是抓不住它们的 —— 必须真的把进程拉起来，
 * 看它有没有跑到。（路径被劈开时 cmd 的原话是
 * `'C:\Users\…\Roaming\DSH' is not recognized as an internal or external command`。）
 *
 * 这也是它存在的理由：本机 dsh 的真路径就带空格
 * （`…\AppData\Roaming\DSH Desktop\host-commands\…\dsh.cmd`），
 * 所以这不是"某个用户的环境问题"，而是**这台机器上必然会踩**的。
 *
 * 手法：造一个 .cmd 垫片（内容是把收到的参数写进 out.txt），
 * 用真的 `spawnBackgroundDsh` / `runDshSync` 去跑它，再读 out.txt 对内容。
 * 不依赖 dsh、不依赖内核、不占端口，几秒钟跑完。
 *
 * 跑法：node test/spawn-quote.js
 * （非 Windows 上退出码 2 = 环境不满足，这条命令行的坑本来也只存在于 Windows）
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
  // 用系统临时目录，不用仓库里的 build/ —— 那个目录会被打包脚本清空，
  // 而且它不入库。测试的现场就该放在临时目录里，跑完自己删。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-'));
  const spacedDir = path.join(root, 'probe space');   // 带空格 —— 这是主角
  const plainDir = path.join(root, 'probe-plain');    // 不带空格 —— 对照组
  fs.mkdirSync(spacedDir, { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });

  // 垫片：把收到的所有参数写进自己旁边的 out.txt（%~dp0 = 脚本所在目录）。
  const body = '@echo off\r\necho %* > "%~dp0out.txt"\r\n';
  const spacedCmd = path.join(spacedDir, 'hello.cmd');
  const plainCmd = path.join(plainDir, 'hello.cmd');
  fs.writeFileSync(spacedCmd, body);
  fs.writeFileSync(plainCmd, body);
  const spacedOut = path.join(spacedDir, 'out.txt');
  const plainOut = path.join(plainDir, 'out.txt');
  const resetOut = (file) => { try { fs.unlinkSync(file); } catch { /* 本来就没有 */ } };
  const outText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');

  const log = () => {};

  try {
    section('1. 拆命令：不能把带空格的路径劈开');
    equal('裸的带空格路径 → 整段当程序名', resolveCommand(spacedCmd), [spacedCmd]);
    equal('带空格的路径 + 自带参数 → 程序名粘回去，参数分开',
      resolveCommand(`${spacedCmd} --profile desktop`), [spacedCmd, '--profile', 'desktop']);
    equal('`node <带空格的脚本>` → 脚本路径粘回一个参数',
      resolveCommand(`node ${spacedCmd} extra`), ['node', spacedCmd, 'extra']);
    equal('整体加引号 → 剥掉引号还是整段',
      resolveCommand(`"${spacedCmd}" --profile desktop`), [spacedCmd, '--profile', 'desktop']);
    equal('不带空格的路径照旧', resolveCommand(plainCmd), [plainCmd]);
    equal('纯命令名照旧按空白拆', splitCommand('dsh --profile desktop'), ['dsh', '--profile', 'desktop']);
    equal('stripOuterQuotes 只剥最外层', stripOuterQuotes(`"${spacedCmd}"`), spacedCmd);

    // 这一条是「不许多粘」的反面证据：没有任何前缀真的存在于磁盘上时，
    // 不许把参数粘起来（粘的依据是磁盘上真有那个文件，不是猜）。
    equal('不存在的东西不许乱粘',
      resolveCommand('dsh --profile desktop'), ['dsh', '--profile', 'desktop']);

    equal('拼出来的命令行：程序名整段加引号',
      commandLine(spacedCmd, ['--profile', 'desktop']), `"${spacedCmd}" --profile desktop`);

    section('2. 真进程：后台拉起（三种写法都必须跑起来）');
    for (const [label, command] of [
      ['A. 裸的带空格路径', spacedCmd],
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

    section('3. 对照组：路径不带空格（原来就是好的，别改坏）');
    resetOut(plainOut);
    const bgPlain = spawnBackgroundDsh({ command: plainCmd, profile: 'desktop', log });
    await wait(1000);
    const plainText = outText(plainOut);
    bgPlain.dispose();
    await wait(200);
    check('D. 不带空格的路径', plainText.length > 0, plainText || '垫片没跑');

    section('4. runDshSync（测试装门插件走的就是这条路）');
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
  console.error(`测试自己炸了：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
