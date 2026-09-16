'use strict';

/**
 * 测试用的「门」保障：没开就自己拉起一个后台 DSH，开着的就直接用。
 *
 * 为什么需要：面板层测试和端到端测试都要有一个 DSH 在 47821 上开门，
 * 以前得先手动起内核、跑完可能还留着。现在测试自己负责起、也负责收，
 * 于是「一条命令从头跑到尾」成立，也不会留下孤儿进程。
 */

const { probePort, waitForPort, spawnBackgroundDsh } = require('../../src/door/locate');

const HOST = process.env.DSH_PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PANEL_PORT || 47821);
const PROFILE = process.env.DSH_PANEL_PROFILE || 'dshdoor';

function doorIsUp(host = HOST, port = PORT) {
  return probePort(host, port, 800);
}

/**
 * 确保门是开的。
 *
 * @returns {Promise<{started: boolean, stop: () => void}>}
 *   `started` 说明这个内核是本次测试拉起来的（测试结束时要收摊）；
 *   如果是本来就在跑的，`stop()` 是空操作 —— **绝不杀别人的内核**。
 */
async function ensureDoor({ host = HOST, port = PORT, profile = PROFILE, log = () => {} } = {}) {
  if (await doorIsUp(host, port)) {
    log('info', `门已经在 ${host}:${port} 上，直接用它`);
    return { started: false, stop() {} };
  }

  log('info', `门没开，自己拉起一个后台 DSH（profile=${profile}）`);
  const kernel = spawnBackgroundDsh({
    command: process.env.DSH_PANEL_DSH || 'dsh',
    profile,
    log,
  });
  const ok = await waitForPort(host, port, { totalMs: 120000 });
  if (!ok) {
    kernel.dispose();
    throw new Error(`后台 DSH 起来了但 ${host}:${port} 一直没开门（profile=${profile}）`);
  }
  return {
    started: true,
    stop() {
      kernel.dispose();
    },
  };
}

module.exports = { ensureDoor, doorIsUp, HOST, PORT, PROFILE };
