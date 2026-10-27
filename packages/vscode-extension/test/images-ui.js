'use strict';
const assert = require('node:assert/strict');
const images = require('../media/images');

const sha256 = 'a'.repeat(64);
const original = { kind: 'image', id: `image:${sha256}`, sha256, name: '测试图.gif', mimeType: 'image/gif', byteLength: 1024,
  data: 'PRIVATE_PIXELS', dataUrl: 'data:image/gif;base64,PRIVATE_PIXELS', uri: 'file:///private/source.gif', text: 'not image metadata' };
const reference = images.descriptor(original);
assert.deepEqual(Object.keys(reference), ['kind', 'id', 'sha256', 'name', 'mimeType', 'byteLength']);
assert.equal(reference.mimeType, 'image/gif');
assert.equal(JSON.stringify(reference).includes('PRIVATE_PIXELS'), false, 'Draft descriptors must not retain image bytes');
assert.equal(JSON.stringify(reference).includes('private/source'), false, 'Draft descriptors must not retain arbitrary source locations');
for (const patch of [{ sha256: 'broken' }, { id: 'image:other' }, { mimeType: 'image/svg+xml' }, { byteLength: 0 }, { byteLength: 8 * 1024 * 1024 + 1 }, { byteLength: 1.5 }]) assert.equal(images.descriptor({ ...original, ...patch }), undefined);
assert.equal(images.mimeType('image/jpg', 'x.jpg'), 'image/jpeg');
assert.equal(images.mimeType('', 'x.WEBP'), 'image/webp');
assert.equal(images.mimeType('image/svg+xml', 'x.png'), undefined);
assert.equal(images.mimeType('text/plain', 'x.png'), undefined);
assert.equal(images.mimeType('', 'x.bmp'), undefined);

assert.equal(images.attachmentsError([reference]), undefined);
assert.equal(images.attachmentsError(Array(5).fill(reference)).includes('4'), true);
assert.equal(images.attachmentsError(Array(3).fill({ ...reference, byteLength: 8 * 1024 * 1024 })).includes('16 MiB'), true);
assert.equal(images.attachmentsError([{ kind: 'content', text: 'a'.repeat(256 * 1024) }, reference]), undefined, 'Image bytes do not consume the text snapshot budget');
assert.equal(images.attachmentsError([{ kind: 'content', text: 'a'.repeat(256 * 1024 + 1) }, reference]).includes('256 KiB'), true);
assert.equal(images.attachmentsError(Array(21).fill({ kind: 'content', text: '' })).includes('20'), true);

const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
assert.equal(images.safeDataUrl(gif), true);
assert.equal(images.base64(gif), gif.slice(gif.indexOf(',') + 1));
for (const value of ['https://example.com/picture.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64," onerror="bad', 'data:image/png;base64,']) assert.equal(images.safeDataUrl(value), false);
const cache = images.createPreviewCache(1024, 2);
cache.put('one', gif); cache.put('two', gif); assert.equal(cache.size, 2);
assert.equal(cache.get('one'), gif);
assert.deepEqual(cache.put('three', gif), ['two'], 'Preview cache evicts the least recently used entry');
assert.equal(cache.size, 2); assert.equal(cache.byteLength, gif.length * 2);
assert.deepEqual(cache.put('unsafe', 'data:image/svg+xml;base64,PHN2Zz4='), []);
assert.equal(cache.size, 2); cache.clear(); assert.equal(cache.byteLength, 0); assert.equal(cache.size, 0);
console.log('PASS image UI metadata-only references, MIME/size/count/text budgets, original GIF data and bounded preview cache');
