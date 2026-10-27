import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemeMediaHandler, handleMediaRequest, cancelMediaRequest, closeMediaRequests, MEDIA_CAPABILITY } from '../lib/media.js';
import { doorStatusPayload } from '../lib/status.js';
import { gatePrompts } from '../lib/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfkAAAAASUVORK5CYII=', 'base64');
const route = '/dsh-memes/pack/memes/like/image.png';
const chinese = '/dsh-memes/pack/memes/like/' + encodeURIComponent('比心.png');
const spaced = '/dsh-memes/pack/memes/like/' + encodeURIComponent('my image.png');
let mode = 'ok', requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (mode === 'missing') { res.writeHead(404); res.end('missing'); return; }
  if (mode === 'redirect') { res.writeHead(302, { Location: 'http://192.0.2.1/private' }); res.end(); return; }
  if (mode === 'hang') return;
  if (req.url === '/dsh-memes-api?packId=all') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (mode === 'bad-json') { res.end('{'); return; }
    if (mode === 'bad-shape') { res.end('{"ok":true,"memes":{}}'); return; }
    if (mode === 'large') { res.end(JSON.stringify({ ok: true, memes: [], data: 'x'.repeat(5000) })); return; }
    if (mode === 'chunk-large') { res.write('{"ok":true,"data":"'); res.write('x'.repeat(5000)); res.end('","memes":[]}'); return; }
    res.end(JSON.stringify({ ok: true, memes: [
      { url: route, caption: '双手比心', keywords: '开心 比心', file_name: 'image.png', tag: 'like' },
      { url: chinese, caption: '比心', file_name: '比心.png' },
      { url: spaced, caption: '空格', file_name: 'my image.png' },
      { url: route, caption: '重复' },
      ...['https://example.com/x', '//example.com/x', 'file:///x', '/api/settings', '/dsh-memes/../secret', '/dsh-memes/%2e%2e/secret', '/dsh-memes/%252e%252e/secret', '/dsh-memes/x?remoteDir=1', '/dsh-memes/%5csecret', '/dsh-memes/a%2fb', '/dsh-memes/%00'].map(url => ({ url, caption: '无效' })),
    ] }));
    return;
  }
  res.setHeader('content-type', mode === 'svg' ? 'image/svg+xml' : 'image/png');
  res.end(mode === 'wrong-signature' ? Buffer.from('<html>not a png</html>') : png);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const webServer = { host: '127.0.0.1', port: server.address().port };
const media = createMemeMediaHandler(webServer, { timeoutMs: 1000 });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS ${name}`); }
try {
  await check('local web endpoints only; optional adapter state is explicit', async () => {
    for (const host of ['example.com', '192.0.2.1', '127.0.0.2', '127.0.0.1@example.com', undefined]) assert.equal(createMemeMediaHandler({ ...webServer, host }), undefined);
    for (const port of [0, undefined, -1, 65536, 'bad']) {
      const waiting = createMemeMediaHandler({ ...webServer, port });
      assert.ok(waiting); await assert.rejects(() => waiting.catalog(), /图片服务当前不可用/); waiting.dispose();
    }
    assert.equal(createMemeMediaHandler(undefined), undefined);
    assert.deepEqual(doorStatusPayload({ media: media.capability }).capabilities.media, MEDIA_CAPABILITY);
    assert.equal(doorStatusPayload({}).capabilities.media, undefined);
    const wildcard = createMemeMediaHandler({ ...webServer, host: '0.0.0.0' });
    assert.equal((await wildcard.catalog()).items.length, 3); wildcard.dispose();
    const startingServer = { host: '127.0.0.1', port: 0 }, starting = createMemeMediaHandler(startingServer);
    startingServer.port = webServer.port;
    assert.equal((await starting.catalog()).items.length, 3); starting.dispose();
  });
  await check('catalog contains only whitelisted plugin routes and bounded metadata', async () => {
    const catalog = await media.catalog();
    assert.deepEqual(catalog, { provider: 'dsh-meme', items: [
      { id: route, caption: '双手比心', keywords: '开心 比心', name: 'image.png', tag: 'like' },
      { id: chinese, caption: '比心', keywords: '', name: '比心.png', tag: '' },
      { id: spaced, caption: '空格', keywords: '', name: 'my image.png', tag: '' },
    ] });
    assert.deepEqual(requests.slice(-1), ['/dsh-memes-api?packId=all']);
  });
  await check('valid images preserve exact bytes without exposing the web endpoint', async () => {
    const image = await media.read(route);
    assert.deepEqual(image, { provider: 'dsh-meme', id: route, mimeType: 'image/png', data: png.toString('base64') });
    assert.equal((await media.read(chinese)).data, png.toString('base64'));
    assert.equal((await media.read(spaced)).data, png.toString('base64'));
    assert.ok(!JSON.stringify(image).includes(String(webServer.port)));
    assert.equal((await media.read(route, { sourceOrigin: `http://127.0.0.1:${webServer.port}` })).data, png.toString('base64'));
    const before = requests.length;
    await assert.rejects(() => media.read(route, { sourceOrigin: 'http://127.0.0.1:1' }));
    assert.equal(requests.length, before, 'a different local server cannot be substituted');
  });
  await check('unknown IDs and noncanonical routes never make requests', async () => {
    const before = requests.length;
    for (const id of ['/dsh-memes/pack/unlisted.png', '/dsh-memes/../secret', '/dsh-memes/%2e%2e/secret', 'http://127.0.0.1/private', '/api/settings', undefined]) await assert.rejects(() => media.read(id));
    assert.equal(requests.length, before);
  });
  await check('missing plugin, redirects, invalid catalogs and invalid image types fail clearly', async () => {
    for (const state of ['missing', 'redirect', 'bad-json', 'bad-shape']) {
      mode = state; await assert.rejects(() => media.catalog());
    }
    mode = 'svg'; await assert.rejects(() => media.read(route), /图片格式不受支持/);
    mode = 'wrong-signature'; await assert.rejects(() => media.read(route), /图片格式不受支持/);
    mode = 'ok';
  });
  await check('content-length and chunked byte limits both stop oversized responses', async () => {
    const bounded = createMemeMediaHandler(webServer, { maxBytes: 1024 });
    for (const state of ['large', 'chunk-large']) { mode = state; await assert.rejects(() => bounded.catalog(), /大小限制/); }
    bounded.dispose(); mode = 'ok';
  });
  await check('timeout, caller cancellation and service unloading abort active reads', async () => {
    mode = 'hang';
    const fast = createMemeMediaHandler(webServer, { timeoutMs: 30 });
    await assert.rejects(() => fast.catalog(), /超时/); fast.dispose();
    const controller = new AbortController(), pending = media.catalog({ signal: controller.signal });
    const cancelled = assert.rejects(() => pending, /取消/); controller.abort(); await cancelled;
    const disposable = createMemeMediaHandler(webServer);
    const active = disposable.catalog(), unloaded = assert.rejects(() => active, /取消/);
    disposable.dispose(); await unloaded;
    await assert.rejects(() => disposable.catalog()); mode = 'ok';
  });
  await check('RPC requests stay separate from ACP; unknown methods/providers get structured errors', async () => {
    const replies = [], state = { mediaHandler: media, respond: frame => replies.push(frame) };
    assert.equal(handleMediaRequest({ method: 'dsh-door/media/catalog' }, state), false);
    assert.equal(handleMediaRequest({ id: 0, method: 'session/prompt' }, state), false);
    handleMediaRequest({ id: 1, method: 'dsh-door/media/missing', params: { provider: 'dsh-meme' } }, state);
    handleMediaRequest({ id: 2, method: 'dsh-door/media/catalog', params: { provider: 'other' } }, state);
    assert.equal(replies[0].error.code, -32601); assert.equal(replies[1].error.code, -32602);
    handleMediaRequest({ id: 3, method: 'dsh-door/media/catalog', params: { provider: 'dsh-meme' } }, state);
    for (let tries = 0; state.mediaReads.size && tries < 100; tries++) await delay(5);
    assert.equal(replies.at(-1).result.provider, 'dsh-meme'); assert.equal(state.mediaReads.size, 0);
  });
  await check('RPC cancellation and connection closure do not send stale results', async () => {
    mode = 'hang';
    const replies = [], state = { mediaHandler: media, respond: frame => replies.push(frame) };
    const frame = { id: 4, method: 'dsh-door/media/catalog', params: { provider: 'dsh-meme' } };
    handleMediaRequest(frame, state);
    assert.equal(cancelMediaRequest({ method: '$/cancelRequest', params: { id: 4 } }, state), true);
    for (let tries = 0; state.mediaReads.size && tries < 100; tries++) await delay(5);
    assert.equal(replies[0].error.code, -32800);
    handleMediaRequest({ ...frame, id: 5 }, state); closeMediaRequests(state);
    for (let tries = 0; state.mediaReads.size && tries < 100; tries++) await delay(5);
    assert.equal(replies.length, 1); assert.equal(state.mediaReads.size, 0);
    mode = 'ok';
  });
  await check('inbound gate intercepts catalog/read/status and preserves ACP traffic in the same chunk', async () => {
    const replies = [], state = { mediaHandler: media, respond: frame => replies.push(frame), pending: new Map() };
    const frames = [
      { id: 10, method: 'dsh-door/media/catalog', params: { provider: 'dsh-meme' } },
      { id: 11, method: 'dsh-door/media/read', params: { provider: 'dsh-meme', id: route } },
      { id: 12, method: 'dsh-door/status' },
      { method: 'session/cancel', params: { sessionId: 'current' } },
    ];
    const encoder = new TextEncoder(), source = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')); controller.close();
    } });
    const forwarded = [];
    for await (const chunk of gatePrompts(source, state, () => {})) forwarded.push(JSON.parse(new TextDecoder().decode(chunk)));
    assert.deepEqual(forwarded, [frames.at(-1)]);
    for (let tries = 0; state.mediaReads.size && tries < 100; tries++) await delay(5);
    assert.deepEqual(replies.find(frame => frame.id === 12).result.capabilities.media, MEDIA_CAPABILITY);
    assert.equal(replies.find(frame => frame.id === 10).result.items.length, 3);
    assert.equal(replies.find(frame => frame.id === 11).result.data, png.toString('base64'));
    closeMediaRequests(state);
  });
} finally {
  media.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(`\nPASS dsh-meme media adapter (${passed} checks)`);
