'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FrameReader, SocketWriter } = require('../src/door/transport-budget');
const { DoorClient } = require('../src/door/client');
const net = require('node:net');
(async () => {
  const lines = [], text = JSON.stringify({ text: '跨块中文🙂' });
  const reader = new FrameReader({ maxBytes: 128, receive: line => lines.push(JSON.parse(line)) });
  for (const byte of Buffer.from(text + '\n')) reader.push(Buffer.from([byte]));
  assert.deepEqual(lines, [{ text: '跨块中文🙂' }]);
  const small = new FrameReader({ maxBytes: 16, receive() { throw new Error('must not parse oversized frame'); } });
  small.push(Buffer.alloc(8, 97)); small.push(Buffer.alloc(8, 97));
  assert.throws(() => small.push(Buffer.from('a')), error => error.code === 'ACP_TRANSPORT_LIMIT');
  assert.equal(small.bytes, 0);
  const socket = new EventEmitter(), writes = [];
  socket.write = text => { writes.push(text); return false; };
  const writer = new SocketWriter(socket, { maxBytes: 12 });
  writer.write('1234'); writer.write('5678'); writer.write('abcd');
  assert.deepEqual(writes, ['1234']); assert.equal(writer.queue.length, 2);
  assert.throws(() => writer.write('!'), /预算/);
  socket.emit('drain'); assert.deepEqual(writes, ['1234', '5678']);
  socket.emit('drain'); assert.deepEqual(writes, ['1234', '5678', 'abcd']);
  writer.dispose(); assert.equal(socket.listenerCount('drain'), 0);
  const server = net.createServer(connection => {
    connection.once('data', value => { const request = JSON.parse(String(value));
      connection.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\n');
      connection.on('data', () => connection.write('x'.repeat(513)));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new DoorClient({ host: '127.0.0.1', port: server.address().port, maxFrameBytes: 512, maxPending: 1 });
  try {
    await client.connect();
    const pending = client.request('slow', {});
    await assert.rejects(client.request('extra', {}), /活动请求/);
    await assert.rejects(pending, error => error.code === 'ACP_TRANSPORT_LIMIT');
    assert(!client.isConnected);
  } finally { client.close(); await new Promise(resolve => server.close(resolve)); }
  const peers = new Set();
  const reconnectServer = net.createServer(connection => {
    peers.add(connection); connection.on('close', () => peers.delete(connection));
    let text = '';
    connection.on('data', value => {
      text += value.toString('utf8'); let at;
      while ((at = text.indexOf('\n')) >= 0) {
        const frame = JSON.parse(text.slice(0, at)); text = text.slice(at + 1);
        connection.write(JSON.stringify({ id: frame.id, result: frame.method === 'initialize' ? { protocolVersion: 1 } : { reconnected: true } }) + '\n');
      }
    });
  });
  await new Promise(resolve => reconnectServer.listen(0, '127.0.0.1', resolve));
  const reconnecting = new DoorClient({ host: '127.0.0.1', port: reconnectServer.address().port });
  try {
    await reconnecting.connect();
    reconnecting.close();
    await reconnecting.connect({ initializeTimeoutMs: 100 });
    assert.deepEqual(await reconnecting.request('echo', {}, { timeoutMs: 100 }), { reconnected: true }, 'A delayed close from the previous socket must not close the replacement connection');
  } finally {
    reconnecting.close(); for (const peer of peers) peer.destroy();
    await new Promise(resolve => reconnectServer.close(resolve));
  }
  console.log('PASS UTF-8, unterminated frame cap, bounded slow writer, drain order, active limit and TCP failure propagation');
})().catch(error => { console.error(error); process.exitCode = 1; });
