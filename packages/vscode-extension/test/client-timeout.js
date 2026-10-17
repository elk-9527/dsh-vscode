'use strict';

/**
 * ACP 客户端的超时与取消边界测试。
 *
 * 这些场景不能用假函数代替：最危险的情况正是“TCP 端口可以连接，但对端不是 ACP、
 * 或接受连接后不回复”。因此本套件在 127.0.0.1 上建立临时 TCP 服务，使用真实 socket
 * 验证握手、普通请求与取消请求都不会永久等待，并固定 TCP 分片不会破坏中文。
 */

const net = require('node:net');
const { DoorClient, DoorTimeoutError } = require('../src/door/client');
const { cancelHistoryRequest, runHistoryRequest } = require('../../dsh-door/lib/history-requests.cjs');

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

  section('5. UTF-8 字符跨 TCP 数据块时不得出现乱码');
  await withServer((socket, frame) => {
    if (frame.method !== 'initialize') return;
    const payload = Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: '中文助手' },
        agentCapabilities: {},
      },
    })}\n`, 'utf8');
    const chinese = Buffer.from('中', 'utf8');
    const at = payload.indexOf(chinese);
    // 故意只发送“中”的第一个字节，稍后再发余下字节。TCP 不保留 write 边界，
    // 客户端必须使用有状态解码器，而不能对每个 chunk 单独 toString('utf8')。
    socket.write(payload.subarray(0, at + 1));
    setTimeout(() => socket.write(payload.subarray(at + 1)), 15);
  }, async (port) => {
    const client = new DoorClient({ host: '127.0.0.1', port, log: () => {} });
    const result = await client.connect({ initializeTimeoutMs: 300 });
    check('跨分片的中文按原文解码', result.agentInfo.name === '中文助手', result.agentInfo.name);
    client.close();
  });

  section('6. 历史查询取消后仍可使用同一条 ACP 连接');
  const states = new WeakMap(); let started, historyState, sawCancel = false;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await withServer((socket, frame) => {
    if (frame.method === 'initialize') { reply(socket, frame.id, { protocolVersion: 1 }); return; }
    let state = states.get(socket);
    if (!state) {
      state = { respond: value => socket.write(JSON.stringify(value) + '\n'), sessionsHandler: { list: () => new Promise(() => {}) } };
      states.set(socket, state);
      socket.on('close', () => { state.historyClosed = true; for (const controller of state.historyReads?.values() || []) controller.abort(); });
    }
    if (frame.method === 'dsh-door/sessions/list') {
      historyState = state; void runHistoryRequest(frame, 'list', state).catch(() => socket.destroy()); started();
    } else if (cancelHistoryRequest(frame, state)) sawCancel = true;
    else if (frame.method === 'session/list') reply(socket, frame.id, { sessions: [] });
  }, async port => {
    const client = new DoorClient({ host: '127.0.0.1', port }); let timer;
    try {
      await client.connect(); const controller = new AbortController();
      const pending = client.listHistory({ query: 'cancel', signal: controller.signal });
      await requestStarted; controller.abort();
      const error = await Promise.race([pending.then(() => undefined, error => error), new Promise(resolve => { timer = setTimeout(() => resolve(new Error('历史取消未及时完成')), 1500); })]);
      clearTimeout(timer);
      check('实际客户端取消通知被历史请求处理器接收', sawCancel);
      check('取消返回明确的取消结果', error?.code === -32800, error?.message);
      check('内核读取不响应取消时也释放请求位置', historyState.historyReads.size === 0);
      const list = await client.listKernelSessions();
      check('取消历史不会关闭 ACP 或阻塞后续请求', client.isConnected && Array.isArray(list.sessions));
    } finally { clearTimeout(timer); client.close(); }
  });

  section('7. 非对象 JSON 帧不会中断握手或后续请求');
  await withServer((socket, frame) => {
    if (frame.method === 'initialize') {
      socket.write('null\n[]\n42\n"unexpected"\n');
      reply(socket, frame.id, { protocolVersion: 1 });
    } else reply(socket, frame.id, { ok: true });
  }, async port => {
    const client = new DoorClient({ host: '127.0.0.1', port });
    try {
      await client.connect({ initializeTimeoutMs: 300 });
      check('异常帧之后仍能完成握手并查询', (await client.request('test/after-invalid', {})).ok === true);
    } finally { client.close(); }
  });

  section('8. 结果观察按传输顺序同步完成且不破坏请求隔离');
  await withServer((socket, frame) => {
    if (frame.method === 'initialize') { reply(socket, frame.id, { protocolVersion: 1 }); return; }
    if (frame.method === 'test/ordered-result') {
      socket.write([
        { jsonrpc: '2.0', id: frame.id, result: { value: 'reply' } },
        { jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'fixture', update: { sessionUpdate: 'config_option_update', configOptions: [] },
        } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
    } else if (frame.method === 'test/rpc-error') {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'fixture error' } }) + '\n');
    } else reply(socket, frame.id, { ok: true });
  }, async port => {
    const client = new DoorClient({ host: '127.0.0.1', port });
    try {
      await client.connect();
      const order = [];
      let received;
      const notification = new Promise(resolve => { received = resolve; });
      client.once('update', () => { order.push('notification'); received(); });
      const result = await client.request('test/ordered-result', {}, { onResult: () => order.push('reply') });
      await notification;
      check('结果观察先于后续配置通知而不延迟通知', JSON.stringify(order) === JSON.stringify(['reply', 'notification']), JSON.stringify(order));
      check('同步结果观察保持原始 Promise 回复', result.value === 'reply');
      let observerError;
      try {
        await client.request('test/observer-fails', {}, { onResult: () => { throw new Error('fixture observer rejected'); } });
      } catch (error) { observerError = error; }
      check('结果消费者错误仅拒绝对应请求', observerError?.message === 'fixture observer rejected', observerError?.message);
      check('结果消费者失败后连接和后续请求仍可用', client.isConnected && (await client.request('test/after-observer', {})).ok);
      let observed = 0;
      const rpcError = await client.request('test/rpc-error', {}, { onResult: () => { observed += 1; } }).catch(error => error);
      check('内核错误回复不调用成功结果观察', rpcError.code === -32602 && observed === 0);
    } finally { client.close(); }
  });

  section('9. 模型目录延迟注册时有界等待，不重复成功回调');
  for (const restore of [false, true]) {
    const frames = []; let accepted = 0;
    await withServer((socket, frame) => {
      if (frame.method === 'initialize') return reply(socket, frame.id, { protocolVersion: 1 });
      frames.push(frame);
      if (frames.length < 3) socket.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        error: { code: -32603, message: 'Internal error', data: { details: frames.length === 1
          ? 'no adapter registered for provider "fixture"' : 'pi-ai provider "fixture" has no configured model "delayed"' } } }) + '\n');
      else reply(socket, frame.id, { sessionId: 'ready-session', configOptions: [] });
    }, async port => {
      const client = new DoorClient({ host: '127.0.0.1', port });
      try {
        await client.connect();
        const options = { preset: 'standard', modelReadyTimeoutMs: 2000 };
        const consume = () => { accepted++; };
        const result = restore ? await client.resumeSession('history', '/fixture', options, consume)
          : await client.newSession('/fixture', options, consume);
        check(`${restore ? '恢复' : '建立'}等待模型注册后成功一次`, result.sessionId === 'ready-session' && accepted === 1 && frames.length === 3);
        check('等待保持会话参数且不发送客户端等待选项', frames.every(frame => JSON.stringify(frame.params) === JSON.stringify(frames[0].params))
          && !('modelReadyTimeoutMs' in frames[0].params) && !('signal' in frames[0].params));
      } finally { client.close(); }
    });
  }
  for (const mode of ['deadline', 'cancel', 'close', 'other-error', 'observer']) {
    let calls = 0; const controller = new AbortController();
    await withServer((socket, frame) => {
      if (frame.method === 'initialize') return reply(socket, frame.id, { protocolVersion: 1 });
      if (frame.method.startsWith('$/')) return;
      calls++;
      if (mode === 'observer') return reply(socket, frame.id, { sessionId: 'ready-session' });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: mode === 'other-error' ? -32602 : -32603,
        message: 'Internal error', data: { details: 'no adapter registered for provider "fixture"' } } }) + '\n');
      if (mode === 'cancel') setTimeout(() => controller.abort(), 30);
      if (mode === 'close') setTimeout(() => socket.destroy(), 30);
    }, async port => {
      const client = new DoorClient({ host: '127.0.0.1', port });
      try {
        await client.connect(); const started = Date.now();
        const error = await client.newSession('/fixture', { signal: controller.signal, modelReadyTimeoutMs: mode === 'deadline' ? 90 : 1500 },
          () => { throw Object.assign(new Error('observer rejected'), { code: -32603, data: { details: 'no adapter registered for provider "fixture"' } }); })
          .then(() => undefined, caught => caught);
        const elapsed = Date.now() - started;
        check(`${mode} 保留失败且没有重复请求`, Boolean(error) && calls === 1 && elapsed < 1200);
        if (mode === 'deadline') check('永久缺失只使用同一个等待期限', error.code === -32603 && elapsed >= 70);
        if (mode === 'cancel') check('等待中取消立即结束', error.code === -32800 && elapsed < 500);
        if (mode === 'observer') check('成功回复的观察错误不触发模型重试', error.message === 'observer rejected');
      } finally { client.close(); }
    });
  }

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
