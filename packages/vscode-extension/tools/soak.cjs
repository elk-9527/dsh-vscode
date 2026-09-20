#!/usr/bin/env node
/*
 * 耐力测试（soak）：使面板所使用的内核**持续工作十余分钟**，观察其是否自行退出。
 *
 * 设置该工具的原因（2026-09-19）：
 * 用户报告"对话数次后出现 read ECONNRESET"，查阅日志后得到一条稳定规律 —— **每个自启的
 * 内核均在启动约 35 秒后以 code=1 退出**。而当时全部测试均为"启动并建立会话后即结束"
 * （约 15 秒），**"能够启动但无法长时间存活"这一类故障没有任何测试可以覆盖**。
 * vscode-check 的 --linger 观察的是"保持连接且不发送请求"，本工具观察的是
 * **"保持连接，并且持续发送请求"**：每 N 秒实际发送一个回合，全程记录内核自身的输出。
 *
 * 用法：
 *   node tools/soak.cjs --profile vscode-panel --minutes 10
 *   node tools/soak.cjs --profile dshdoor --minutes 10 --label 最小档
 *   node tools/soak.cjs --profile vscode-panel --minutes 10 --turn-every 60 \
 *     --patch %TEMP%\dsh-panel-test-door-47830.yml --port 47830
 *
 * 退出码：0 = 全程未断开、内核未自行退出；1 = 连接断开或内核退出（将打印内核最后的输出）。
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

/** 端口上是否存在监听（内核启动需要数秒，不可在启动后立即连接）。 */
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
  // 内核的输出量较大，仅在出错与收尾时打印；进度通过单行覆盖式的短提示显示。
  if (level === 'error' || level === 'warn') console.log(line);
};

(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  // 取「确实能够启动」的候选命令：本机的 `dsh` 是桌面端提供的垫片，在扩展的进程中经常
  // 无法找到，而 soak 不应将时间耗费在一次必然失败的尝试上。
  const candidates = dshCommandCandidates({ dshCommand: 'dsh', homedir: os.homedir() });
  const command = candidates.find((item) => /^node\s/i.test(item)) || candidates[0];
  const extraArgs = patch ? ['--patch', patch] : [];
  console.log(`\n耐力测试：档「${profile}」，${minutes} 分钟，每 ${turnEvery} 秒一个回合`);
  console.log(`  命令 ${command}`);
  console.log(`  插件 ${host}:${port}${patch ? `（patch ${patch}）` : ''}`);
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
          ? `内核已启动，但该插件未监听 ${host}:${port}（内核在 ${report.kernelExit.at} 即退出）`
          : `等待 180 秒，${host}:${port} 上始终没有该插件`,
      );
    }
    console.log(`  ${stamp()} 该插件已监听`);
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
      `\r  ${stamp()} ${alive ? '✅ 仍在运行' : '❌ 已断开'}  回合 ${report.turns}  已跑 ${(
        (Date.now() - started) / 60000
      ).toFixed(1)} 分钟   `,
    );
    if (!alive) break;
    if (Date.now() >= next) {
      next = Date.now() + turnEvery * 1000;
      try {
        // 单个回合最多允许 3 分钟：内核中途退出时 prompt 会 reject，
        // 但内核若长时间不响应，soak 不应随之阻塞。
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
  // 结论必须在收尾**之前**计算：收尾本身会终止进程，'exit' 事件一旦触发即被视为"内核退了"，
  // 运行正常的情况也会被判为失败（第一版实现即因此出现误判）。
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
    console.log(`  内核最后说的话：${ok ? '（未输出任何内容，一直运行）' : '（空 —— 未输出任何内容即退出）'}`);
  }
  if (!ok) {
    console.log('\n  这次跑的时间线（最后 40 行日志）：');
    for (const line of lines.slice(-40)) console.log(`    ${line}`);
  }

  session.dispose();
  try { client.close(); } catch { /* 连接已断开 */ }
  background.dispose();
  console.log(ok ? '\n  ✅ 全程没断，内核没自己退\n' : '\n  ❌ 这一趟出问题了（上面有内核的原话）\n');
  process.exit(ok ? 0 : 1);
})();
