'use strict';
const assert = require('node:assert/strict');
const { renderMarkdown, createStreamingRenderer } = require('../media/markdown');
const samples = ['Paragraph **bold**.\n\n## Heading\n\n- one\n- two\n\n> quote\n> next\n\n```js\nconst text = "a";\n\n// inside fence\n```\n\nTail',
  'open\n\n```js\n\nnot closed', 'one\r\n\r\ntwo\r\n', '[label][ref]\n\n[ref]: https://example.invalid\n\n| a | b |\n| - | - |\n', '```bad!\n\nlast\n', '# A\n\n<script>alert(1)</script>\n\n',
  '分层如下\n| 层 | 文件 | 说明 |\n| --- | :---: | ---: |\n| 模型 | [文件](public/task-model.js#L10) | `a|b` |\n| 界面 | [应用](public/app.js) | **状态** |\n\n完成。',
  '| 甲 | 乙 |\r\n| --- | --- |\r\n| a\\|b | [`code`](src/a(b).js) |\r\n\r\n后续段落'];
for (const maxChars of [16, 128 * 1024]) for (const sample of samples) for (const size of [1, 2, 7, 37]) {
  const renderer = createStreamingRenderer({ maxChars }); let committed = '';
  for (let end = 1; end <= sample.length + size; end += size) {
    const text = sample.slice(0, end), patch = renderer.render(text);
    if (patch.reset) committed = '';
    committed += patch.appendHtml;
    assert.equal(committed + patch.tailHtml, renderMarkdown(text), `Chunk parity: ${size}/${end}/${maxChars}`);
  }
  const patch = renderer.render('replacement\n\nnew'); if (maxChars > sample.length) assert(patch.reset); assert.equal(patch.appendHtml + patch.tailHtml, renderMarkdown('replacement\n\nnew'));
  renderer.clear(); const fresh = renderer.render('fresh'); assert.equal(fresh.appendHtml + fresh.tailHtml, renderMarkdown('fresh'));
}
console.log('PASS streaming Markdown parity across chunk boundaries, open fences, lists, quotes, CRLF, fallback budget and reset');
