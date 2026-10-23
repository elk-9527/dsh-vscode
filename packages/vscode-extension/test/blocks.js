'use strict';

/**
 * 编辑器上下文拼块（src/dsh/blocks.js）的纯函数测试。
 *
 * 该逻辑的关键在于"发送给模型的实际内容" —— 拼接错误不会报错，
 * 只会导致模型无法获得上下文，或被围栏破坏结构。因此需要逐字断言。
 *
 * 运行方式：node test/blocks.js
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildPromptBlocks, selectionText, contentText, fenceFor } = require(path.join(
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
  check('三块：链接、读取说明、用户的话', blocks.length === 3, JSON.stringify(blocks));
  check('第一块是 resource_link', blocks[0].type === 'resource_link');
  check('name 用相对路径', blocks[0].name === 'src/panel/view.js');
  check('uri 原样带过去', blocks[0].uri === file.uri);
  check('没有把文件内容写进去（resource_link 里没有 text 字段）', blocks[0].text === undefined);
  check('链接说明要求读取正文，不能沿用其他附件', blocks[1].type === 'text' && blocks[1].text.includes('没有正文') && blocks[1].text.includes('文件读取工具') && blocks[1].text.includes('之前的选区'));
  check('当前链接的名称和原地址逐项列出', JSON.parse(blocks[1].text.split('\n')[1])[0].name === file.name && JSON.parse(blocks[1].text.split('\n')[1])[0].uri === file.uri);
  check('用户的话在最后', blocks.at(-1).type === 'text' && blocks.at(-1).text === '这个文件是干嘛的');
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
  check('四块：正文、链接、读取说明、用户的话', blocks.length === 4, JSON.stringify(blocks));
  check('第一块是 text（选中的代码）', blocks[0].type === 'text');
  check('写了位置', blocks[0].text.includes('src/app.js'));
  check('带语言标记的围栏', blocks[0].text.includes('```javascript'));
  check('代码原样在里面', blocks[0].text.includes('const answer = 42;'));
  check('第二块是带上同一文件的链接', blocks[1].type === 'resource_link' && blocks[1].uri === 'file:///d%3A/app.js');
  check('还是以用户的话结尾', blocks.at(-1).text === '这行是干嘛的');
}

// ── 4. 代码本身包含反引号时，围栏须加长 ──────────────────
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
  // 关键：围栏出现次数必须为偶数（开始一次、结束一次），否则内容会被截断。
  const count = text.split(fence).length - 1;
  check('围栏成对出现（内容没被提前闭合）', count === 2, `出现 ${count} 次`);
}

// ── 5. 语言名不合法时不写入语言标记 ─────────────────────
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
  check('同样有内容块（不会发出空 prompt）', blocks.length === 4, JSON.stringify(blocks));
  check('补了一句自然语言，不是空字符串', blocks.at(-1).text.trim().length > 0, JSON.stringify(blocks.at(-1).text));
  const file = { kind: 'file', name: 'a.js', uri: 'file:///a.js' };
  check('只有文件链接时也一样', buildPromptBlocks('   ', [file]).length === 3);
}

// ── 7. 多个附件保持顺序 ─────────────────────────────────
section('7. 带了多个附件：顺序要稳定');
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
  const descriptions = blocks.filter(block => block.type === 'text' && block.text.startsWith('本轮显式提供的文件链接'));
  check('多个链接只补充一次读取说明', descriptions.length === 1);
  check('统一说明中的链接清单与原链接逐项对应', JSON.parse(descriptions[0].text.split('\n')[1]).map(item => item.name).join(',') === links.join(','));
  check('用户的话永远在最后一块', blocks[blocks.length - 1].type === 'text' && blocks[blocks.length - 1].text === '一起看看');
}

// ── 8. 形状不合法的附件不得破坏消息 ─────────────────────
section('8. 形状不对的附件：跳过，不得破坏消息结构');
{
  const weird = [
    { kind: 'file' }, // 没有 uri、没有 name：无法处理，跳过
    { kind: 'selection', text: '   ' }, // 只有空白：跳过
    'not an object',
    42,
    null,
  ];
  const blocks = buildPromptBlocks('还在吗', weird);
  check('这些怪东西都被跳过了，只剩用户的话', blocks.length === 1, JSON.stringify(blocks));
  check('只剩的那块是用户的话', blocks[0].text === '还在吗');

  // 但"包含正文、仅缺少位置"的选区需要保留 —— 正文是用户实际提供的内容，
  // 位置属于附加信息（无法确定位置时记为「未知位置」）。
  const partial = buildPromptBlocks('看这个', [{ kind: 'selection', text: 'ok', language: 'js' }]);
  check('没有 uri 的选区仍然把正文带上', blocks.length === 1 && partial[0].text.includes('ok'), JSON.stringify(partial));
  check('位置写不出来时如实写「未知位置」', partial[0].text.includes('未知位置'), JSON.stringify(partial[0].text));
}

// ── 9. 未保存/已修改文件 → 编辑器快照 ──────────────────
section('9. 未保存或已修改文件使用编辑器当前快照');
{
  const current = {
    kind: 'content',
    scope: 'file',
    name: 'src/dirty.js',
    text: 'const disk = 1;\nconst editor = 2;',
    language: 'javascript',
    detail: '当前文件（含未保存修改）',
  };
  const blocks = buildPromptBlocks('以哪个值为准？', [current]);
  check('编辑器快照作为正文发送', blocks.length === 2 && blocks[0].type === 'text', JSON.stringify(blocks));
  check('快照正文包含当前位置与当前代码',
    blocks[0].text.includes('src/dirty.js') && blocks[0].text.includes('const editor = 2;'),
    blocks[0].text);
  check('快照没有伪造 resource_link', !blocks.some((item) => item.type === 'resource_link'), JSON.stringify(blocks));
  check('快照使用安全的语言围栏', contentText(current).includes('```javascript'));
  check('内核拼接正文后围栏与提问仍分行', blocks.map(block => block.text || '').join('').includes('```\n\n以哪个值为准？'));

  const empty = buildPromptBlocks('', [{ kind: 'content', name: 'Untitled-1', text: '', language: 'plaintext' }]);
  check('空的未保存文件也保留一段明确上下文', empty.length === 2 && /Untitled-1/.test(empty[0].text), JSON.stringify(empty));
}

section('10. 审查报告仅作为显式附件正文发送');
{
  const report = { kind: 'review', name: '代码审查报告', text: '# 代码审查\n\n## [P1] 加法错误\n\n计算 sample.js:1', finishedAt: '2026-10-05T12:00:00Z', uri: 'dsh-result:/review/fixture.md' };
  const blocks = buildPromptBlocks('解释这个问题', [report]);
  check('报告全文与提问保持顺序', blocks.length === 2 && blocks[0].text.includes(report.text) && blocks[1].text === '解释这个问题', JSON.stringify(blocks));
  check('报告说明历史快照与审查时间', blocks[0].text.includes('代码快照') && blocks[0].text.includes(report.finishedAt));
  check('虚拟报告地址不作为文件读取链接', !blocks.some(item => item.type === 'resource_link'));
  const removed = buildPromptBlocks('不发送报告', []);
  check('移除附件后没有报告内容', removed.length === 1 && !removed[0].text.includes('加法错误'));
}

section('11. 正文快照逐字保留且不会重新读源文件');
{
  const raw = '首行\r\n```\r\n尾部  \r\n\r\n';
  const captured = { kind: 'content', name: 'saved.md', sourcePath: 'C:/project/saved.md', uri: 'file:///saved.md', text: raw,
    snapshotAt: '2026-10-12T00:00:00.000Z', isDirty: false, scope: 'file', language: 'markdown' };
  const blocks = buildPromptBlocks('使用这份正文', [captured]);
  check('正文 CRLF 和尾部空白逐字保留', blocks[0].text.includes(raw + '\n````'));
  check('完整文件、实际路径和保存状态明确', /完整文件正文快照/.test(blocks[0].text) && blocks[0].text.includes(captured.sourcePath) && blocks[0].text.includes('加入时已保存'));
  check('加入时间保留在发送上下文', blocks[0].text.includes(captured.snapshotAt));
  check('带来源 uri 的快照也不触发延后文件读取', blocks.length === 2 && !blocks.some(block => block.type === 'resource_link'));
  const spaces = { ...captured, kind: 'selection', text: ' \t\r\n', startLine: 2, endLine: 2, isDirty: true };
  const selection = buildPromptBlocks('保留空白选区', [spaces]);
  check('空白选区快照正文不被省略或修剪', selection.length === 2 && selection[0].text.includes(spaces.text));
  check('选区显示实际范围和未保存状态', selection[0].text.includes('2–2 行') && selection[0].text.includes('含未保存修改'));
  const untitled = buildPromptBlocks('', [{ ...captured, isUntitled: true, sourcePath: 'Untitled-1', text: '' }]);
  check('未保存空文件的事实与正文保留', untitled.length === 2 && untitled[0].text.includes('未保存文件'));
}

section('12. 附加正文仅按明确来源范围描述');
{
  const body = '退出码：1\r\n失败证据：```\r\n保留尾部空白  \r\n';
  for (const scope of ['test', 'test-log', undefined]) {
    const attachment = { kind: 'content', scope, name: '测试摘要', sourcePath: '执行 test-7', text: body,
      snapshotAt: '2026-10-12T00:00:00.000Z', language: 'plaintext' };
    const blocks = buildPromptBlocks('准备修复', [attachment]);
    const heading = blocks[0].text.split('\n')[0];
    check(`范围 ${String(scope)} 不被称为完整文件或选区`, !/完整文件|编辑器里选中/.test(heading), heading);
    check(`范围 ${String(scope)} 保留中性来源、时间和逐字正文`,
      heading === `以下是附加正文快照（执行 test-7，快照时间 ${attachment.snapshotAt}）：` && blocks[0].text.includes(body));
    check(`范围 ${String(scope)} 保留提问并使用成对安全围栏`,
      blocks.length === 2 && blocks[1].text === '准备修复' && blocks[0].text.split('````').length === 3);
  }
  const selection = contentText({ kind: 'content', scope: 'selection', sourcePath: 'src/app.js', text: body,
    startLine: 3, endLine: 5, isDirty: true, language: 'javascript' });
  check('content 选区按真实选区描述范围与保存状态', selection.startsWith('以下是在编辑器里选中的代码快照（src/app.js，3–5 行，含未保存修改）：'));
  check('content 选区保留正文且不声称完整文件', selection.includes(body) && !selection.includes('完整文件正文快照'));
  const unnamed = contentText({ kind: 'content', text: '证据' });
  check('缺失来源使用未知来源，不虚构文件', unnamed.startsWith('以下是附加正文快照（（未知来源））：'));
}

section('13. 旧式文件链接提供本轮元数据，不读取或混用正文');
{
  const localPath = path.resolve('build', 'reference # 文.txt');
  const uri = pathToFileURL(localPath).href;
  const name = '引号"与换行\n文件';
  const attachments = [
    { kind: 'file', name, uri },
    { kind: 'file', name: 'remote', uri: 'https://example.invalid/file.txt' },
    { kind: 'file', name: 'network', uri: 'file://remote.invalid/share/file.txt' },
    { kind: 'file', name: 'invalid', uri: 'not a uri' },
    { kind: 'file', name: 'encoded-separator', uri: 'file:///a%2Fb.txt' },
  ];
  const blocks = buildPromptBlocks('读取本轮文件', attachments);
  const hint = blocks.at(-2), references = JSON.parse(hint.text.split('\n')[1]);
  check('本机路径按当前平台解码空格、井号和 Unicode', references[0].localPath === localPath);
  check('原 URI 和名称保持原值', references[0].uri === uri && references[0].name === name);
  check('名称中的换行通过 JSON 转义，不改变元数据结构', hint.text.split('\n')[1].includes('\\n') && references.length === attachments.length);
  check('每个原链接仍按输入顺序保留', blocks.slice(0, attachments.length).every((block, index) => block.type === 'resource_link' && block.uri === attachments[index].uri));
  check('远程、网络、无效及编码分隔符链接不虚构本机路径', references.slice(1).every(item => !Object.hasOwn(item, 'localPath')));
  check('链接元数据没有读取或加入文件正文', references.every(item => !Object.hasOwn(item, 'text') && !Object.hasOwn(item, 'content')));
  check('用户提问仍最后发送且保持原文', blocks.at(-1).text === '读取本轮文件');
  const snapshot = { kind: 'content', scope: 'file', sourcePath: localPath, uri, text: '捕获的正文', snapshotAt: '2026-10-12T00:00:00Z' };
  const captured = buildPromptBlocks('使用快照', [snapshot]);
  check('有正文快照的文件不增加链接元数据或延后读取要求', captured.length === 2 && captured[0].text.includes(snapshot.text));
}

console.log('\n════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项检查`);
} else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const name of failures) console.log(`   - ${name}`);
  process.exit(1);
}
