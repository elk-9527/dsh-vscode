'use strict';
const assert = require('node:assert/strict');
const { captionKey, createCatalog, markers, safeDataUrl } = require('../media/memes');

const first = { id: '/dsh-memes/pack/memes/like/a.jpg', caption: '双手比心卖萌，星星眼超开心', name: 'a.jpg', keywords: '比心 喜欢 卖萌 可爱 开心', tag: 'like' };
const longCaption = '长'.repeat(120);
const catalog = createCatalog([first, { id: '/dsh-memes/pack/memes/b.gif', caption: longCaption, name: 'animated.gif' }]);
assert.equal(catalog.find('双手比心卖萌，星星眼超开心').id, first.id);
assert.equal(catalog.find('双手比心卖萌, 星星眼超开心').id, first.id);
assert.equal(catalog.find(longCaption.slice(0, 80)).caption, longCaption);
assert.equal(catalog.find(longCaption.slice(0, 100)).caption, longCaption);
assert.equal(catalog.find('ANIMATED.GIF').name, 'animated.gif');
assert.equal(catalog.find('看起来很像但是没有这张图'), undefined);
assert.equal(catalog.find('可爱'), undefined, 'Individual common keywords must not select arbitrary images');
assert.equal(captionKey('Ａ B，C！'), captionKey('abc'));

const ambiguous = createCatalog([first, { ...first, id: '/dsh-memes/other/memes/a.jpg' }]);
assert.equal(ambiguous.find(first.caption), undefined, 'Duplicate captions remain text');
const unsafe = createCatalog([{ ...first, id: 'https://example.com/a.png' }, { ...first, id: '/dsh-memes/\u0000.png' }, { ...first, id: '/dsh-memes/\\a.png' }, first, first]);
assert.equal(unsafe.items.length, 1);
assert.equal(unsafe.items[0].id, first.id);

const source = '开头[表情: 双手比心卖萌，星星眼超开心]结尾 [表情：动画]';
assert.deepEqual(markers(source).map(item => item.caption), [first.caption, '动画']);
for (const hit of markers(source)) assert.equal(source.slice(hit.index, hit.index + hit.raw.length), hit.raw);
assert.deepEqual(markers('[表情: 未闭合'), []);
assert.deepEqual(markers('[表情: ]'), []);
assert.deepEqual(markers('`[表情: 代码]` [表情: 正文]').map(item => item.caption), ['正文']);
assert.deepEqual(markers('```js\n[表情: 代码]\n```\n[表情: 正文]').map(item => item.caption), ['正文']);
assert.deepEqual(markers('``code `[表情: 代码]` `` [表情: 正文]').map(item => item.caption), ['正文']);
assert.equal(markers('[表情: 描述](http://127.0.0.1:1234/dsh-memes/a.jpg)')[0].raw, '[表情: 描述](http://127.0.0.1:1234/dsh-memes/a.jpg)');

for (const type of ['png', 'jpeg', 'gif', 'webp']) assert.equal(safeDataUrl(`data:image/${type};base64,YQ==`), true);
for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,YQ==', 'javascript:alert(1)', 'data:text/html;base64,YQ==', 'data:image/png;base64,\" onerror=\"alert(1)', 'data:image/png;base64,']) assert.equal(safeDataUrl(value), false);
assert.equal(safeDataUrl('data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024)), false);
console.log('PASS dsh-meme caption markers, exact/normalized/truncated matching, ambiguity fallback, code exclusion and data-image boundary');
