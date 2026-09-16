'use strict';

/**
 * 编辑器上下文拼块（src/dsh/blocks.js）的纯函数测试。
 *
 * 这块逻辑的价值全在"发给模型的到底是什么" —— 拼错了不会报错，
 * 只会让模型看不到上下文、或者被围栏搞乱。所以要逐字断。
 *
 * 跑法：node test/blocks.js
 */

const path = require('node:path');
const { buildPromptBlocks, selectionText, fenceFor } = require(path.join(
  __dirname,
  '..',
  'src',
  'dsh',
  'blocks.js',
));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────`);
}

console.log('DSH Panel · 编辑器上下文拼块');

// ── 1. 只有文字 ─────────────────────────────────────────
section('1. 只有文字时，行为跟以前一模一样');
{
  const blocks = buildPromptBlocks('你好', []);
  check('只有一个内容块', blocks.length === 1, JSON.stringify(blocks));
  check('类型是 text', blocks[0].type === 'text');
  check('文字原样保留', blocks[0].text === '你好');

  check('没给 attachments 也不炸', buildPromptBlocks('嗨').length === 1);
  check('attachments 给 null 也不炸', buildPromptBlocks('嗨', null).length === 1);
  check('attachments 里混了 null 会被跳过', buildPromptBlocks('嗨', [null, undefined]).length === 1);
}

// ── 2. 当前文件 → resource_link ─────────────────────────
section('2. 当前文件走 resource_link（让 DSH 自己读，不塞正文）');
{
  const file = {
    kind: 'file',
    name: 'src/panel/view.js',
    uri: 'file:///d%3A/dsh-vscode/packages/vscode-extension/src/panel/view.js',
    detail: '当前文件',
  };
  const blocks = buildPromptBlocks('这个文件是干嘛的', [file]);
  check('两块：链接 + 用户的话', blocks.length === 2, JSON.stringify(blocks));
  check('第一块是 resource_link', blocks[0].type === 'resource_link');
  check('name 用相对路径', blocks[0].name === 'src/panel/view.js');
  check('uri 原样带过去', blocks[0].uri === file.uri);
  check('没有把文件内容塞进去（resource_link 里没有 text 字段）', blocks[0].text === undefined);
  check('用户的话在最后', blocks[1].type === 'text' && blocks[1].text === '这个文件是干嘛的');
  check('绝不出现内核明确拒绝的 resource 类型', !JSON.stringify(blocks).includes('"resource"'));
}

// ── 3. 选中的代码 → 正文 + 链接 ──────────────────────────
section('3. 选中的代码：正文直接给，另外附一条链接');
{
  const sel = {
    kind: 'selection',
    name: 'src/app.js',
    uri: 'file:///d%3A/app.js',
    text: 'const answer = 42;\nconsole.log(answer);',
    language: 'javascript',
    detail: '选中 2 行',
  };
  const blocks = buildPromptBlocks('这行是干嘛的', [sel]);
  check('三块：正文 + 链接 + 用户的话', blocks.length === 3, JSON.stringify(blocks));
  check('第一块是 text（选中的代码）', blocks[0].type === 'text');
  check('写了位置', blocks[0].text.includes('src/app.js'));
  check('带语言标记的围栏', blocks[0].text.includes('```javascript'));
  check('代码原样在里面', blocks[0].text.includes('const answer = 42;'));
  check('第二块是带上同一文件的链接', blocks[1].type === 'resource_link' && blocks[1].uri === 'file:///d%3A/app.js');
  check('还是以用户的话结尾', blocks[2].text === '这行是干嘛的');
}

// ── 4. 围栏要能扛住代码里本来就有反引号 ──────────────────
section('4. 代码里本来就有反引号时，围栏必须加长');
{
  check('普通内容用三个反引号', fenceFor('const a = 1;') === '```');
  check('内容里有 ``` 时用四个', fenceFor('```\ncode\n```') === '````');
  check('内容里有 ````` 时用六个', fenceFor('`````') === '``````');

  const tricky = {
    kind: 'selection',
    name: 'README.md',
    uri: 'file:///d%3A/README.md',
    text: '用法：\n```js\nconsole.log(1)\n```',
    language: 'markdown',
  };
  const blocks = buildPromptBlocks('看看', [tricky]);
  const text = blocks[0].text;
  const fence = fenceFor(tricky.text);
  check('用的是加长后的围栏', text.includes(fence), fence);
  // 关键：围栏出现次数必须是偶数（开一次、闭一次），否则内容会被截断。
  const count = text.split(fence).length - 1;
  check('围栏成对出现（内容没被提前闭合）', count === 2, `出现 ${count} 次`);
}

// ── 5. 语言名不合法时不写语言 ───────────────────────────
section('5. 语言名可疑时宁可不写');
{
  for (const bad of ['', 'javascript\n```', 'x'.repeat(40), '中文语言', 'js;rm -rf']) {
    const out = selectionText({
      name: 'a.js',
      uri: 'file:///a.js',
      text: 'x',
      language: bad,
    });
    const firstLine = out.split('\n')[1];
    check(`语言 ${JSON.stringify(bad)} 不会写进围栏`, firstLine === '```', firstLine);
  }
  const good = selectionText({ name: 'a.ts', uri: 'file:///a.ts', text: 'x', language: 'typescript' });
  check('正常的语言名照写', good.split('\n')[1] === '```typescript');
  const cpp = selectionText({ name: 'a.cpp', uri: 'file:///a.cpp', text: 'x', language: 'c++' });
  check('c++ 这种带加号的也放行', cpp.split('\n')[1] === '```c++');
}

// ── 6. 只有附件、没有文字 ───────────────────────────────
section('6. 只有上下文、一个字都没打');
{
  const sel = { kind: 'selection', name: 'a.js', uri: 'file:///a.js', text: 'x', language: 'js' };
  const blocks = buildPromptBlocks('', [sel]);
  check('照样有内容块（不会发出空 prompt）', blocks.length === 3, JSON.stringify(blocks));
  check('补了一句人话，不是一个空字符串', blocks[2].text.trim().length > 0, JSON.stringify(blocks[2].text));
  const file = { kind: 'file', name: 'a.js', uri: 'file:///a.js' };
  check('只有文件链接时也一样', buildPromptBlocks('   ', [file]).length === 2);
}

// ── 7. 多个附件保持顺序 ─────────────────────────────────
section('7. 带了好几个：顺序要稳定');
{
  const items = [
    { kind: 'file', name: 'a.js', uri: 'file:///a.js' },
    { kind: 'selection', name: 'b.js', uri: 'file:///b.js', text: 'let b;', language: 'js' },
    { kind: 'file', name: 'c.md', uri: 'file:///c.md' },
  ];
  const blocks = buildPromptBlocks('一起看看', items);
  const links = blocks.filter((b) => b.type === 'resource_link').map((b) => b.name);
  check('三条链接都在', links.length === 3, JSON.stringify(links));
  check('顺序跟传入一致', links.join(',') === 'a.js,b.js,c.md', links.join(','));
  check('用户的话永远在最后一块', blocks[blocks.length - 1].type === 'text' && blocks[blocks.length - 1].text === '一起看看');
}

// ── 8. 形状不对的附件不能把消息搞坏 ─────────────────────
section('8. 形状不对的附件：跳过，不许把消息搞坏');
{
  const weird = [
    { kind: 'file' }, // 没有 uri、没有 name：无从下手，跳过
    { kind: 'selection', text: '   ' }, // 只有空白：跳过
    'not an object',
    42,
    null,
  ];
  const blocks = buildPromptBlocks('还在吗', weird);
  check('这些怪东西都被跳过了，只剩用户的话', blocks.length === 1, JSON.stringify(blocks));
  check('只剩的那块是用户的话', blocks[0].text === '还在吗');

  // 但"有正文、只是不知道在哪"的选区要带上 —— 正文才是用户真正想给的东西，
  // 位置只是锦上添花（写不出位置就写「未知位置」）。
  const partial = buildPromptBlocks('看这个', [{ kind: 'selection', text: 'ok', language: 'js' }]);
  check('没有 uri 的选区仍然把正文带上', blocks.length === 1 && partial[0].text.includes('ok'), JSON.stringify(partial));
  check('位置写不出来时如实写「未知位置」', partial[0].text.includes('未知位置'), JSON.stringify(partial[0].text));
}

console.log('\n════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项检查`);
} else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const name of failures) console.log(`   - ${name}`);
  process.exit(1);
}
