'use strict';

/**
 * ACP 客户端的超时与取消边界测试。
 *
 * 这些场景不能用假函数代替：最危险的情况正是“TCP 端口可以连接，但对端不是 ACP、
 * 或接受连接后不回复”。因此本套件在 127.0.0.1 上建立临时 TCP 服务，使用真实 socket
 * 验证握手、普通请求与取消请求都不会永久等待。
 */

const net = require('node:net');
const { DoorClient, DoorTimeoutError } = require('../src/door/client');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`);
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────`);
}

async function withServer(onFrame, run) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        onFrame(socket, JSON.parse(line));
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function reply(socket, id, result) {
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

async function main() {
  console.log('DSH Panel · ACP 客户端超时（真实 TCP）');

  section('1. TCP 可连接但不说 ACP：握手必须按时失败');
  await withServer(() => {}, async (port) => {
    const client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    const started = Date.now();
    let error;
    try {
      await client.connect({ timeoutMs: 200, initializeTimeoutMs: 70 });
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - started;
    check('返回的是明确的握手超时', error instanceof DoorTimeoutError && error.method === 'initialize', error && error.message);
    check('没有无限等待', elapsed >= 50 && elapsed < 1000, `${elapsed}ms`);
    check('握手失败后 socket 已关闭', client.isConnected === false);
  });

  section('2. 普通短请求没有回复：从 pending 中退出');
  await withServer((socket, frame) => {
    if (frame.method === 'initialize') reply(socket, frame.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake' },
      agentCapabilities: {},
    });
  }, async (port) => {
    const client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    await client.connect({ initializeTimeoutMs: 200 });
    let error;
    try {
      await client.request('dsh-door/test/no-reply', {}, { timeoutMs: 60 });
    } catch (caught) {
      error = caught;
    }
    check('短请求按方法名报告超时', error instanceof DoorTimeoutError && error.method === 'dsh-door/test/no-reply', error && error.message);
    client.close();
  });

  section('3. 长请求允许运行；用户取消后不能永久等待');
  const seen = [];
  await withServer((socket, frame) => {
    seen.push(frame.method);
    if (frame.method === 'initialize') reply(socket, frame.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake' },
      agentCapabilities: {},
    });
    // 故意不回应 long/request 与 $/cancel_request，模拟对端取消链路卡住。
  }, async (port) => {
    const client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    await client.connect({ initializeTimeoutMs: 200 });
    const controller = new AbortController();
    const pending = client.request('long/request', {}, {
      signal: controller.signal,
      timeoutMs: 0,
      abortTimeoutMs: 60,
    });
    setTimeout(() => controller.abort(), 15);
    let error;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    check('取消通知确实发给了对端', seen.includes('$/cancel_request'), seen.join(', '));
    check('对端不回取消结果时按时结束', error instanceof DoorTimeoutError && /取消请求超时/.test(error.message), error && error.message);
    client.close();
  });

  section('4. 调用前已经取消：不应先发送再补取消');
  const sent = [];
  await withServer((socket, frame) => {
    sent.push(frame.method);
    if (frame.method === 'initialize') reply(socket, frame.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake' },
      agentCapabilities: {},
    });
  }, async (port) => {
    const client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    await client.connect({ initializeTimeoutMs: 200 });
    const controller = new AbortController();
    controller.abort();
    let error;
    try {
      await client.request('should/not/send', {}, { signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('预先取消会明确失败', error && error.code === -32800, error && error.message);
    check('预先取消的业务请求没有写入 socket', !sent.includes('should/not/send'), sent.join(', '));
    client.close();
  });

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) console.log(`✅ 全部通过：${passed} 项检查`);
  else {
    console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const failure of failures) console.log(`   - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('测试自身发生异常：', error);
  process.exit(1);
});
