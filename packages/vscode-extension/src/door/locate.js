'use strict';

/**
 * 找到「门」，找不到就在后台拉起一个 DSH。
 *
 * 这是用户批准的兜底路径：桌面端在跑就连它（同一个内核）；没在跑就起一个
 * 后台 DSH —— 它和桌面端**共用同一份 `$DSH_HOME`**，所以记忆、会话记录、
 * 配置文件都是同一份，不是另立门户。
 *
 * 为什么端口是固定的 47821：门插件在自己的 cordis.patch.yml 里写死了端口。
 * 两个内核不可能同时占它，所以「连不上 = 桌面端没在跑」，判断很干净。
 */

const net = require('node:net');
const { spawn } = require('node:child_process');

/** 探测一个端口是否能连上（不握手，只探 TCP）。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 等端口起来，直到超时。 */
async function waitForPort(host, port, { totalMs = 90000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(host, port, Math.min(intervalMs * 2, 1000))) return true;
    await delay(intervalMs);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在后台拉起一个 DSH。
 *
 * 用 `--no-open`（别弹浏览器）和 `--port 0`（网页界面端口让系统随便挑，
 * 反正我们走的是门，不用它的网页界面）。stdio 全部丢掉：这是后台进程，
 * 它的输出对用户没有意义，也不该污染扩展的输出通道。
 *
 * @param {object} options
 * @param {string} options.command dsh 程序名或完整路径。
 * @param {string} options.profile profile 名（里面要装好门插件）。
 * @param {(level: string, message: string) => void} options.log
 * @returns {{child: import('node:child_process').ChildProcess, dispose: () => void}}
 */
function spawnBackgroundDsh({ command, profile, log }) {
  const args = ['--profile', profile, '--no-open', '--port', '0'];
  log('info', `后台拉起 DSH：${command} ${args.join(' ')}`);

  const child = spawn(command, args, {
    // Windows 上 dsh 是 .cmd 垫片，必须过一层 shell 才找得到。
    shell: true,
    windowsHide: true,
    stdio: 'ignore',
    // 不要 detached：让子进程跟着扩展宿主走，扩展一停就一起收摊。
    detached: false,
  });

  let disposed = false;
  child.on('error', (error) => {
    log('error', `后台 DSH 起不来：${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (disposed) return;
    log('warn', `后台 DSH 退出了（code=${code} signal=${signal}）`);
  });

  return {
    child,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        child.kill();
        log('info', '已停掉本扩展拉起的后台 DSH');
      } catch (error) {
        log('warn', `停后台 DSH 失败：${error.message}`);
      }
    },
  };
}

module.exports = { probePort, waitForPort, spawnBackgroundDsh, delay };
