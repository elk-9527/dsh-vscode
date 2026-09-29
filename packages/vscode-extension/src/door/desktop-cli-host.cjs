'use strict';

/**
 * Keep the DSH Desktop 0.2 CLI alive under Electron's Node mode.
 *
 * This file is intentionally dependency-free: it is shipped inside the VSIX and is launched by
 * the real Node runtime bundled with DSH Desktop. The Electron child receives an IPC channel;
 * without that channel Electron 44 exits immediately after loading the CLI, even though the DSH
 * kernel has opened servers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const [desktopExecutable, cliEntry, ...args] = process.argv.slice(2);
if (!desktopExecutable || !cliEntry) {
  console.error('DSH Desktop CLI 代理缺少可执行文件或 CLI 入口。');
  process.exit(64);
}
if (!fs.existsSync(desktopExecutable) || !/deepseek harness\.exe$/i.test(desktopExecutable)) {
  console.error(`DSH Desktop 可执行文件不存在：${desktopExecutable}`);
  process.exit(66);
}
const asarIndex = cliEntry.toLowerCase().indexOf('.asar');
const appAsar = asarIndex >= 0 ? cliEntry.slice(0, asarIndex + 5) : '';
if (!appAsar || !fs.existsSync(appAsar)) {
  console.error(`DSH Desktop 的 app.asar 不存在：${appAsar || cliEntry}`);
  process.exit(66);
}

const child = fork(cliEntry, args, {
  execPath: desktopExecutable,
  execArgv: ['--expose-internals'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: desktopExecutable,
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
});

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
let forwardedSignal = '';
child.once('error', (error) => {
  console.error(`DSH Desktop CLI 子进程启动失败：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal && signal !== forwardedSignal) {
    console.error(`DSH Desktop CLI 子进程被 ${signal} 终止。`);
    process.exitCode = 1;
  } else {
    process.exitCode = Number.isInteger(code) ? code : 0;
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    forwardedSignal = signal;
    if (child.connected) child.disconnect();
    if (!child.killed) child.kill(signal);
  });
}
