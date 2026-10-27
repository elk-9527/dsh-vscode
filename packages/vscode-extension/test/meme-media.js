'use strict';
const assert = require('node:assert/strict');
const { MemeMedia, catalogItems, imageDataUrl, validMemeId } = require('../src/panel/memes');

const id = '/dsh-memes/test/memes/like/sample.png';
const item = { id, caption: '测试表情', name: 'sample.png', keywords: '测试 开心', tag: 'like' };
const payload = { provider: 'dsh-meme', items: [item] };
const image = { provider: 'dsh-meme', id, mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') };

(async () => {
  assert.deepEqual(catalogItems(payload), [item]);
  for (const bad of ['https://example.com/a', 'file:///a', '/dsh-memes/../secret', '/dsh-memes/%2e%2e/secret',
    '/dsh-memes/a?token=secret', '/dsh-memes/%00/a', '/dsh-memes/%5c/a', '/dsh-memes/%ZZ']) assert.equal(validMemeId(bad), false, bad);
  assert(validMemeId('/dsh-memes/test/%E4%B8%AD%E6%96%87%20file.gif'));
  assert.throws(() => catalogItems({ ...payload, items: [item, item] }));
  assert.throws(() => catalogItems({ ...payload, items: [{ ...item, keywords: {} }] }));
  assert.equal(imageDataUrl(image, id), 'data:image/png;base64,' + image.data);
  for (const bad of [{ ...image, mimeType: 'image/svg+xml' }, { ...image, id: id + 'x' }, { ...image, data: 'PHN2Zz4=' },
    { ...image, data: image.data + '\n' }, { ...image, data: 'YQ=' }]) assert.throws(() => imageDataUrl(bad, id));

  const posted = [], calls = [];
  const client = { isConnected: true, async request(method, params) { calls.push({ method, params }); return method.endsWith('catalog') ? payload : image; } };
  let scope = { client, status: { capabilities: { media: { protocolVersion: 1, providers: ['dsh-meme'] } } }, view: {}, cwd: 'workspace', sessionId: 'one', trusted: true };
  const media = new MemeMedia({ scope: () => scope, post: value => posted.push(value) });
  await media.handle({ type: 'memeCatalog', requestId: 1 });
  assert.equal(posted.at(-1).available, true);
  await media.handle({ type: 'memeRead', requestId: 2, id });
  assert.equal(posted.at(-1).dataUrl, imageDataUrl(image, id));
  await media.handle({ type: 'memeRead', requestId: 3, id });
  assert.equal(calls.filter(call => call.method.endsWith('read')).length, 1, 'verified media is cached');
  await media.handle({ type: 'memeRead', requestId: 4, id: '/dsh-memes/test/not-catalog.png' });
  assert(posted.at(-1).error); assert.equal(calls.length, 2, 'unlisted media never reaches Door');

  scope.trusted = false;
  await media.handle({ type: 'memeCatalog', requestId: 5 });
  assert.equal(calls.length, 2, 'untrusted workspaces cannot enumerate local media');
  scope.trusted = true;
  await media.handle({ type: 'memeRead', requestId: 6, id, cwd: 'different' });
  assert.equal(calls.length, 2);
  scope.status = undefined;
  await media.handle({ type: 'memeCatalog', requestId: 7 });
  assert.equal(posted.at(-1).available, false); assert.equal(calls.length, 2, 'old Door remains usable without media');

  scope.status = { capabilities: { media: { protocolVersion: 1, providers: ['dsh-meme'] } } };
  let finish;
  client.request = () => new Promise(resolve => { finish = resolve; });
  const waiting = media.handle({ type: 'memeCatalog', requestId: 8 });
  scope.sessionId = 'two';
  finish(payload); await waiting;
  assert.notEqual(posted.at(-1).requestId, 8, 'late content must not enter another session');

  let aborted = false;
  client.request = (_, __, options) => new Promise(resolve => {
    finish = resolve; options.signal.addEventListener('abort', () => { aborted = true; });
  });
  const closing = media.handle({ type: 'memeCatalog', requestId: 9 });
  media.reset(); finish(payload); await closing;
  assert(aborted); assert.equal(posted.at(-1).type, 'memeReset');
  console.log('PASS meme media: catalog allowlist, image validation, cache, old Door, trust/session boundaries and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
