'use strict';
const net = require('node:net');
/** 先确认自建回环连接可用，避免把主机网络限制记录成产品不兼容。 */
async function verifyLoopback() {
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.end(); });
  const sockets = new Set(); let client;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => {
      client = net.connect({ host: '127.0.0.1', port: server.address().port });
      client.setTimeout(2000, () => reject(new Error('回环连接超时')));
      client.once('connect', resolve); client.once('error', reject);
    });
    return { selfConnection: true };
  } catch (cause) {
    throw Object.assign(new Error('本机无法连接自建的回环端口，真实内核与编辑器验证暂不可执行'), { kind: 'environment-blocked', code: 'DSH_LOOPBACK_UNAVAILABLE', cause });
  } finally { client?.destroy(); for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
module.exports = { verifyLoopback };
