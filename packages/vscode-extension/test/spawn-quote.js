'use strict';

/**
 * 「命令路径中包含空格」这一路径的真实进程测试。
 *
 * 覆盖两个只有执行进程才能验证的边界：
 *   1. 路径中的空格属于可执行文件名，不能按参数空白拆分；
 *   2. cmd.exe 的内嵌引号须原样传递，使用 windowsVerbatimArguments 防止二次转义。
 *
 * 单独比对 commandLine() 返回的字符串不能证明操作系统成功执行了该命令。
 * 所有路径均由临时目录生成，分别包含带空格与不带空格的合成夹具。
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
const Module = require('node:module');

const {
  commandLine,
  resolveCommand,
  runDshSync,
  runDshAsync,
  spawnBackgroundDsh,
  splitCommand,
  stripOuterQuotes,
  redactSensitiveOutput,
  desktopDshCommand,
  dshCommandCandidates,
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
async function waitForOutput(file) {
  const deadline = Date.now() + 5000;
  while ((!fs.existsSync(file) || fs.statSync(file).size === 0) && Date.now() < deadline) await wait(50);
}

function loadWithDependencies(file, dependencies) {
  const previous = require.cache[file], load = Module._load;
  try {
    delete require.cache[file];
    Module._load = function (request, parent, ...rest) {
      if (parent?.filename === file && Object.hasOwn(dependencies, request)) return dependencies[request];
      return load.call(this, request, parent, ...rest);
    };
    return require(file);
  } finally {
    Module._load = load;
    if (previous) require.cache[file] = previous; else delete require.cache[file];
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const fixtures = path.resolve(__dirname, '../../../build/test-spawn'); fs.mkdirSync(fixtures, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtures, 'dsh-quote-'));
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
  const secretScript = path.join(root, 'emit-secret.js');
  const fakeWebToken = 'test-web-token-12345';
  const fakeBearer = 'test-bearer-67890';
  fs.writeFileSync(secretScript, [
    `process.stdout.write(${JSON.stringify(`dsh web: http://127.0.0.1:6123/?token=${fakeWebToken}&keep=1\n`)});`,
    `process.stderr.write(${JSON.stringify(`Authorization: Bearer ${fakeBearer}\n`)});`,
  ].join('\n'));
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
      await waitForOutput(spacedOut);
      const text = outText(spacedOut);
      await bg.dispose();
      await wait(200);
      check(label, text.length > 0, text ? `垫片收到：${text}` : '垫片根本没跑（out.txt 没生成）');
    }

    section('3. 对照组：路径不带空格（原本正常，不得改坏）');
    resetOut(plainOut);
    const bgPlain = spawnBackgroundDsh({ command: plainCmd, profile: 'desktop', log });
    await waitForOutput(plainOut);
    const plainText = outText(plainOut);
    await bgPlain.dispose();
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
    for (const command of [spacedCmd, `"${spacedCmd}"`, `${spacedCmd} 自带参数`]) {
      resetOut(spacedOut);
      await runDshAsync({ command, args: ['async-arg'], timeoutMs: 15000 });
      check('异步命令支持带空格的路径及自带参数', outText(spacedOut).includes('async-arg'));
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
    await bgArgs.dispose();
    await wait(200);
    check('带空格的参数原样到达', argText.includes('--patch') && argText.includes('a b.yml'), argText);
    check('profile 名也在（顺带证明参数是按顺序传的）', argText.includes('--profile desktop'), argText);

    section('6. 内核输出中的访问凭据不能写进日志或错误尾部');
    const secretLogs = [];
    const secretBg = spawnBackgroundDsh({
      command: `"${process.execPath}" "${secretScript}"`,
      profile: 'desktop',
      log: (_level, message) => secretLogs.push(message),
    });
    await wait(1000);
    const logged = secretLogs.join('\n');
    const tail = secretBg.stderrTail();
    await secretBg.dispose();
    check('网页地址中的访问凭据已隐藏',
      !logged.includes(fakeWebToken) && logged.includes('token=[已隐藏]') && logged.includes('keep=1'), logged);
    check('认证头中的访问凭据已隐藏',
      !logged.includes(fakeBearer) && !tail.includes(fakeBearer) && tail.includes('Bearer [已隐藏]'), tail);
    check('独立脱敏函数保留无关诊断信息',
      redactSensitiveOutput('error: port=47831').includes('port=47831'));

    section('7. Desktop 官方 CLI 保留随附包管理器及 IPC 生命周期');
    const desktopRoot = path.join(root, 'Desktop install');
    const desktopExe = path.join(desktopRoot, 'DeepSeek Harness.exe');
    const bundledNode = path.join(desktopRoot, 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe');
    const bundledCli = path.join(desktopRoot, 'resources/runtime/cli/bin/dsh.cmd');
    const extensionDir = path.join(root, 'test extension');
    const proxy = path.join(extensionDir, 'src/door/desktop-cli-host.cjs');
    for (const file of [desktopExe, bundledNode, bundledCli, proxy]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(desktopExe, 'fixture executable identity');
    fs.copyFileSync(process.execPath, bundledNode);
    fs.writeFileSync(path.join(desktopRoot, 'resources/app.asar'), 'fixture archive identity');
    fs.writeFileSync(bundledCli, '@echo off\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n');
    fs.writeFileSync(proxy, [
      'const path = require("node:path");',
      'const selected = process.argv[3].replace(/\\\\/g, "/");',
      'if (!selected.endsWith("/@deepseek-ai/dsh-desktop-host/lib/cli.js")) { console.error("legacy entry uses external package manager"); process.exit(23); }',
      'console.log("BUNDLED_PACKAGE_MANAGER " + process.argv.slice(4).join(" "));',
    ].join('\n'));
    const desktopCommand = desktopDshCommand(desktopExe, { extensionDir });
    try {
      const output = runDshSync({ command: desktopCommand, args: ['--version'], timeoutMs: 15000 });
      check('官方入口通过随附 Node 与 IPC 代理执行，参数原样传入', output.includes('BUNDLED_PACKAGE_MANAGER --version'), output);
    } catch (error) {
      check('官方入口通过随附 Node 与 IPC 代理执行，参数原样传入', false, error.message);
    }
    equal('优先使用可维持生命周期的 IPC 命令，官方 cmd 为后备',
      dshCommandCandidates({ desktopExecutables: [desktopExe], extensionDir })[0], desktopCommand);
    fs.unlinkSync(bundledCli);
    check('旧发行没有官方 CLI 时保留普通 bin.js 兼容入口',
      /[\\/]dsh[\\/]lib[\\/]bin\.js/.test(desktopDshCommand(desktopExe, { extensionDir })));

    section('8. 清理完成是可等待的共享边界，测试不得先行退出');
    const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
    const cleanup = deferred(), child = new EventEmitter();
    Object.assign(child, { pid: 123456, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    let stops = 0;
    const isolatedLocate = loadWithDependencies(require.resolve('../src/door/locate'), {
      'node:child_process': { ...require('node:child_process'), spawn: () => child },
      './process': { ...require('../src/door/process'), stopOwnedProcess: () => { stops++; return cleanup.promise; } },
    });
    const background = isolatedLocate.spawnBackgroundDsh({ command: process.execPath, profile: 'fixture', log() {} });
    const stopping = background.dispose(), repeated = background.dispose();
    let stopped = false; void Promise.resolve(stopping).then(() => { stopped = true; });
    await wait(10);
    check('dispose 返回同一个清理 Promise，重复调用只启动一次终止', stopping instanceof Promise && repeated === stopping && stops === 1);
    check('清理尚未完成时，等待 dispose 的调用方不能继续', stopped === false);
    cleanup.resolve(); await stopping;
    check('实际清理结束后再调用 dispose 仍取得同一完成结果', background.dispose() === stopping && stopped === true);

    const helperPath = require.resolve('./helpers/door');
    function helperFor({ startupFails = false, existing = false } = {}) {
      const gate = deferred(); let probes = 0, spawned = 0;
      const kernel = { child: { exitCode: startupFails ? 1 : null, signalCode: null }, dispose: () => gate.promise, stderrTail: () => 'fixture startup failure' };
      const helper = loadWithDependencies(helperPath, { '../../src/door/locate': {
        probePort: async () => existing || ++probes > 1 && !startupFails,
        spawnBackgroundDsh: () => { spawned++; return kernel; }, runDshSync: () => 'fixture',
        dshCommandCandidates: () => ['fixture'], runningDesktopExecutables: () => [],
      } });
      return { helper, gate, spawned: () => spawned };
    }
    const owned = helperFor(), door = await owned.helper.ensureDoor();
    let stopFinished = false; const completion = door.stop();
    void Promise.resolve(completion).then(() => { stopFinished = true; }); await wait(10);
    check('真实测试 helper.stop 原样保留待完成的清理 Promise', completion === owned.gate.promise && !stopFinished);
    owned.gate.resolve(); await completion;
    const failedStartup = helperFor({ startupFails: true }); let startupError;
    const starting = failedStartup.helper.ensureDoor().catch(error => { startupError = error; }); await wait(10);
    check('启动失败也必须先等待已创建内核的清理', startupError === undefined);
    failedStartup.gate.resolve(); await starting;
    check('清理完成后仍保留原始启动失败诊断', /fixture startup failure/.test(startupError?.message));
    const shared = helperFor({ existing: true }), attached = await shared.helper.ensureDoor();
    const sharedStop = attached.stop();
    check('接入已有内核返回可等待的空清理且不启动或停止它', sharedStop instanceof Promise && attached.stop() === sharedStop && shared.spawned() === 0);
    await sharedStop;
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
