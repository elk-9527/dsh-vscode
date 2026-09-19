#!/usr/bin/env node
/*
 * 耐力测试（soak）：让面板那种内核**连着干活十几分钟**，看它会不会自己死。
 *
 * 为什么必须有这个工具（2026-09-19）：
 * 用户报"聊两句就 read ECONNRESET"，翻日志拿到一条硬规律 —— **每个自启的
 * 内核都在起来约 35 秒后退出 code=1**。而当时手上所有测试都是"起来 + 建会话
 * 就收摊"（约 15 秒），**"起得来但活不长"这一整类毛病根本没有测试能看见**。
 * vscode-check 的 --linger 盯的是"连接着不动"，这个工具盯的是
 * **"连接着，而且一直在干活"**：每 N 秒真发一个回合，全程记内核自己的话。
 *
 * 用法：
 *   node tools/soak.cjs --profile vscode-panel --minutes 10
 *   node tools/soak.cjs --profile dshdoor --minutes 10 --label 最小档
 *   node tools/soak.cjs --profile vscode-panel --minutes 10 --turn-every 60 \
 *     --patch %TEMP%\dsh-panel-test-door-47830.yml --port 47830
 *
 * 退出码：0 = 全程没断、内核没自己退；1 = 断了或退了（会打印内核最后的话）。
 */
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { spawnBackgroundDsh, dshCommandCandidates } = require(path.join(ROOT, 'src/door/locate.js'));
const { DoorClient } = require(path.join(ROOT, 'src/door/client.js'));
const { DshSession } = require(path.join(ROOT, 'src/dsh/session.js'));

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const profile = take('--profile', 'vscode-panel');
const label = take('--label', profile);
const minutes = Number(take('--minutes', '10'));
const turnEvery = Number(take('--turn-every', '60'));
const host = take('--host', '127.0.0.1');
const port = Number(take('--port', '47830'));
const patch = take('--patch', '');
const cwd = take('--cwd', path.join(os.tmpdir(), `dsh-soak-${profile}`));

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

/** 端口上有没有人在听（内核起来要几秒，不能一到就连）。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
const lines = [];
const log = (level, text) => {
  const line = `${stamp()} [${level}] ${text}`;
  lines.push(line);
  // 内核的输出很吵，只在出错和收尾时打；进度用一行覆盖式的短提示。
  if (level === 'error' || level === 'warn') console.log(line);
};

(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  // 拿「真能起来」那条候选：本机 `dsh` 是桌面端的垫片，在扩展的进程里经常找不到，
  // 而 soak 不该把时间浪费在一次注定失败的尝试上。
  const candidates = dshCommandCandidates({ dshCommand: 'dsh', homedir: os.homedir() });
  const command = candidates.find((item) => /^node\s/i.test(item)) || candidates[0];
  const extraArgs = patch ? ['--patch', patch] : [];
  console.log(`\n耐力测试：档「${profile}」，${minutes} 分钟，每 ${turnEvery} 秒一个回合`);
  console.log(`  命令 ${command}`);
  console.log(`  门   ${host}:${port}${patch ? `（patch ${patch}）` : ''}`);
  console.log(`  工作目录 ${cwd}\n`);

  const background = spawnBackgroundDsh({ command, profile, log, extraArgs, port });
  const report = {
    kernelExit: null,
    disconnects: [],
    turns: 0,
    turnErrors: 0,
    firstTextAt: null,
  };
  background.child.on('exit', (code, signal) => {
    report.kernelExit = { code, signal, at: stamp() };
  });

  let client;
  let session;
  try {
    const opened = await waitForPort(host, port, 180000);
    if (!opened) {
      throw new Error(
        report.kernelExit
          ? `内核起来了但门没开在 ${host}:${port}（它 ${report.kernelExit.at} 就退了）`
          : `等了 180 秒，${host}:${port} 上一直没有门`,
      );
    }
    console.log(`  ${stamp()} 门开了`);
    client = new DoorClient({ host, port, log });
    client.on('close', (reason) => report.disconnects.push({ reason, at: stamp() }));
    session = new DshSession({ client, log });
    session.on('text', () => {
      if (!report.firstTextAt) report.firstTextAt = stamp();
    });
    await client.connect({ timeoutMs: 60000 });
    await session.start({ cwd });
    console.log(`  ${stamp()} 会话建好了 ${session.sessionId}\n`);
  } catch (error) {
    console.error(`  ❌ 起不来或建不了会话：${error.message}`);
    console.error(`  内核最后说的话：\n${(background.stderrTail() || '（它没说话）').split('\n').slice(-8).join('\n')}`);
    background.dispose();
    process.exit(1);
  }

  const deadline = started + minutes * 60 * 1000;
  let next = Date.now();
  while (Date.now() < deadline) {
    const alive = report.kernelExit === null && report.disconnects.length === 0;
    process.stdout.write(
      `\r  ${stamp()} ${alive ? '✅ 活着' : '❌ 断了'}  回合 ${report.turns}  已跑 ${(
        (Date.now() - started) / 60000
      ).toFixed(1)} 分钟   `,
    );
    if (!alive) break;
    if (Date.now() >= next) {
      next = Date.now() + turnEvery * 1000;
      try {
        // 一个回合最多给 3 分钟：内核半路死了的话 prompt 会 reject，
        // 但万一它卡住不答，soak 也不该跟着一起卡死。
        await Promise.race([
          session.send('回一句：我在。不要用工具。'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('这个回合超过 3 分钟没结束')), 180000),
          ),
        ]);
        report.turns += 1;
      } catch (error) {
        report.turnErrors += 1;
        log('error', `回合失败：${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const elapsed = (Date.now() - started) / 1000;
  // 结论必须在收摊**之前**算：收摊本身会杀进程，'exit' 一到就变成"内核退了"，
  // 明明跑得好好的也会被判红（这个坑第一版就踩了）。
  const ok = report.kernelExit === null && report.disconnects.length === 0 && report.turnErrors === 0;
  console.log('\n');
  console.log('── 结果 ───────────────────────────────────────────');
  console.log(`  档「${label}」跑了 ${elapsed.toFixed(1)} 秒，成功回合 ${report.turns}，失败回合 ${report.turnErrors}`);
  console.log(`  内核自己退出：${report.kernelExit ? `是（code=${report.kernelExit.code} signal=${report.kernelExit.signal}，${report.kernelExit.at}）` : '否'}`);
  console.log(`  连接断开：${report.disconnects.length === 0 ? '0 次' : report.disconnects.map((d) => `${d.at} ${d.reason}`).join(' / ')}`);

  const tail = (background.stderrTail() || '').trim();
  if (tail) {
    console.log(`  内核最后说的话：\n${tail.split('\n').slice(-8).map((line) => `    ${line}`).join('\n')}`);
  } else {
    console.log(`  内核最后说的话：${ok ? '（一句话没说，一直活着）' : '（空 —— 它一个字都没说就退了）'}`);
  }
  if (!ok) {
    console.log('\n  这次跑的时间线（最后 40 行日志）：');
    for (const line of lines.slice(-40)) console.log(`    ${line}`);
  }

  session.dispose();
  try { client.close(); } catch { /* 已经断了 */ }
  background.dispose();
  console.log(ok ? '\n  ✅ 全程没断，内核没自己退\n' : '\n  ❌ 这一趟出问题了（上面有内核的原话）\n');
  process.exit(ok ? 0 : 1);
})();
