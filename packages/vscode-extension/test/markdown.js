'use strict';

/**
 * Markdown 渲染器的单元测试。
 *
 * 该模块是界面中唯一把模型输出转换为 HTML 的位置，因此需要固定两项行为：
 *   1. 注入安全 —— 模型输出不得转换为可执行的 HTML；
 *   2. 真实性能 —— 大段文本渲染不得阻塞（仅在 Node 中测量才准确，
 *      无头浏览器的虚拟时钟会使耗时恒为 0）。
 *
 * 用法：node test/markdown.js
 */

const { renderMarkdown, inline, escapeHtml } = require('../media/markdown');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

// ── 1. 基本语法 ─────────────────────────────────────────

section('1. 基本语法');

check('空输入返回空串', renderMarkdown('') === '');
check('null 返回空串', renderMarkdown(null) === '');
check('普通段落包成 p', renderMarkdown('你好').includes('<p>你好</p>'));

const heading = renderMarkdown('# 标题');
check('一级标题渲染成 h2（h1 留给页面本身）', heading.includes('<h2>标题</h2>'), heading);

const fence = renderMarkdown('```js\nconst a = 1;\n```');
check('代码块渲染成 pre>code', fence.includes('<pre><code class="language-js">'));
check('代码块内容保留', fence.includes('const a = 1;'));

const unclosed = renderMarkdown('```js\nconst a = 1;');
check('未闭合的代码块也照收（流式输出时更稳）', unclosed.includes('<pre><code'), unclosed);

const list = renderMarkdown('- 甲\n- 乙\n- 丙');
check('无序列表渲染成 ul>li', (list.match(/<li>/g) || []).length === 3, list);

const ordered = renderMarkdown('1. 甲\n2. 乙');
check('有序列表渲染成 ol>li', ordered.includes('<ol>') && (ordered.match(/<li>/g) || []).length === 2, ordered);

const quote = renderMarkdown('> 引用一行');
check('引用渲染成 blockquote', quote.includes('<blockquote>引用一行</blockquote>'), quote);

check('粗体', renderMarkdown('这是**重点**').includes('<strong>重点</strong>'));
check('斜体', renderMarkdown('这是*斜*').includes('<em>斜</em>'));
check('行内代码', renderMarkdown('用 `npm pack` 打包').includes('<code>npm pack</code>'));
check(
  '链接渲染成 a[data-href]',
  renderMarkdown('[官网](https://example.com/x)').includes('<a data-href="https://example.com/x"'),
);
check('CRLF 换行也能处理', renderMarkdown('第一行\r\n第二行').includes('<br>'));
check('多段之间分开', (renderMarkdown('第一段\n\n第二段').match(/<p>/g) || []).length === 2);

// ── 2. 注入安全（优先级最高的一组）────────────────────────

section('2. 注入安全');

const script = renderMarkdown('<script>alert(1)</script>');
check('script 标签被转义', !script.includes('<script') && script.includes('&lt;script&gt;'), script);

const img = renderMarkdown('<img src=x onerror="alert(1)">');
check('img onerror 被转义', !img.includes('<img') && img.includes('&lt;img'), img);

const iframe = renderMarkdown('<iframe src="https://evil"></iframe>');
check('iframe 被转义', !iframe.includes('<iframe'), iframe);

const jsLink = renderMarkdown('[点我](javascript:alert(1))');
check('javascript: 链接不被当成链接', !jsLink.includes('<a ') && jsLink.includes('javascript:alert(1)'), jsLink);

const dataLink = renderMarkdown('[点我](data:text/html,<script>alert(1)</script>)');
check('data: 链接不被当成链接', !dataLink.includes('<a '), dataLink);

const attrInjection = renderMarkdown('[x](https://a.com"onmouseover="alert(1))');
// 正确判据：引号必须转义为 &quot;（浏览器解码后仍是属性内部的字符），
// 危险情形是出现未转义的 `"` 导致属性提前闭合。因此检查的是未转义的引号序列。
check(
  'URL 里的引号无法逃出属性',
  attrInjection.includes('&quot;') && !/"\s*onmouseover\s*=/.test(attrInjection),
  attrInjection,
);

const inCode = renderMarkdown('```\n<script>alert(1)</script>\n```');
check('代码块里的 HTML 也被转义', !inCode.includes('<script'), inCode);

const inlineCode = renderMarkdown('`<b>粗</b>`');
check('行内代码里的 HTML 被转义', !inlineCode.includes('<b>') && inlineCode.includes('&lt;b&gt;'), inlineCode);

const langInjection = renderMarkdown('```js" onload="alert(1)\ncode\n```');
check(
  '代码块语言名无法逃出属性',
  // 判据统一：不得出现带未转义引号的 on* 处理器赋值；&quot; 是安全的转义形式。
  !/\son\w+\s*=\s*"/.test(langInjection),
  langInjection,
);

check('转义函数处理 & < > "', escapeHtml('&<>"') === '&amp;&lt;&gt;&quot;');

const sneaky = renderMarkdown('正常文字 <a href="javascript:x">链接</a> 后面');
check('混在正文里的标签只剩文字', !sneaky.includes('<a href'), sneaky);

// ── 3. 真实性能（仅在 Node 中测量才准确）──────────────────

section('3. 性能');

function makeDoc(sections) {
  let out = '';
  for (let i = 0; i < sections; i += 1) {
    out +=
      `## 第 ${i} 节\n\n这是第 ${i} 段正文，带 \`inline code\` 和 **粗体**，还有 *斜体*。\n\n` +
      `- 列表项一\n- 列表项二\n- 列表项三\n\n` +
      '```js\nconst value = ' + i + ';\nfunction demo() { return value; }\n```\n\n' +
      `> 引用第 ${i} 段\n\n`;
  }
  return out;
}

function timeIt(text, rounds) {
  // 先执行预热，避免计入 JIT 编译时间。
  for (let i = 0; i < 3; i += 1) renderMarkdown(text);
  const samples = [];
  for (let i = 0; i < rounds; i += 1) {
    const started = process.hrtime.bigint();
    renderMarkdown(text);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const small = makeDoc(40); // ≈ 10KB
const large = makeDoc(400); // ≈ 100KB
const smallMs = timeIt(small, 7);
const largeMs = timeIt(large, 5);

console.log(`     10KB：${(small.length / 1024).toFixed(1)}KB → ${smallMs.toFixed(2)}ms`);
console.log(`     100KB：${(large.length / 1024).toFixed(1)}KB → ${largeMs.toFixed(2)}ms`);
console.log(`     规模比 ${(large.length / small.length).toFixed(1)}×，耗时比 ${(largeMs / Math.max(smallMs, 0.001)).toFixed(1)}×`);

check('渲染 10KB 在 20ms 以内', smallMs < 20, `${smallMs.toFixed(2)}ms`);
check('渲染 100KB 在 200ms 以内', largeMs < 200, `${largeMs.toFixed(2)}ms`);
// 耗时应当大致随规模线性增长。倍数明显超过规模倍数说明实现中存在平方级复杂度问题。
const scale = large.length / small.length;
const ratio = largeMs / Math.max(smallMs, 0.001);
check(
  `耗时增长不超过规模增长的 4 倍（防 O(n²)）`,
  ratio < scale * 4,
  `规模 ${scale.toFixed(1)}×，耗时 ${ratio.toFixed(1)}×`,
);

// ── 4. 病态输入不得导致阻塞（子进程 + 较小内存上限 + 超时守卫）────

section('4. 病态输入（防死循环）');

/*
 * 背景：此处曾出现严重缺陷 —— 输入中若存在「以 ``` 开头但不构成合法围栏」的行
 * （模型输出残缺代码块时较为常见），渲染器既不按围栏处理、也不按段落接受，
 * 索引不再前进，导致无限循环并耗尽内存；在 webview 中表现为面板无响应。
 *
 * 因此该组测试必须在子进程中运行，并设置较小的堆上限与超时：
 * 实际阻塞时子进程自行终止，不会影响测试进程与整台机器。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PATHOLOGICAL = [
  '```js" onload="alert(1)\ncode\n```',
  '```js x\n没有结束的围栏',
  '````\n四个反引号',
  '   ```abc def\n缩进又带尾巴',
  '```text\n\n\n',
  '```\n```\n```\n```',
  '> \n> \n> ',
  '#\n',
  '1.\n',
  '- \n',
  '``` '.repeat(50),
  '文字```开头但不是围栏',
];

const child = spawnSync(
  process.execPath,
  [
    // 较小的堆上限：实际死循环会迅速因 OOM 终止，而不会耗尽机器内存。
    '--max-old-space-size=192',
    '-e',
    `
    const { renderMarkdown } = require(${JSON.stringify(path.join(__dirname, '..', 'media', 'markdown.js'))});
    const inputs = ${JSON.stringify(PATHOLOGICAL)};
    for (const input of inputs) {
      const out = renderMarkdown(input);
      if (typeof out !== 'string') throw new Error('输出不是字符串：' + input);
    }
    console.log('ok:' + inputs.length);
    `,
  ],
  { timeout: 20000, encoding: 'utf8' },
);

check(
  `${PATHOLOGICAL.length} 种病态输入全部正常返回（没有死循环/爆内存）`,
  child.status === 0 && /ok:/.test(child.stdout || ''),
  child.error
    ? `子进程异常：${child.error.message}`
    : `退出码 ${child.status}，stdout=${(child.stdout || '').trim()}，stderr=${(child.stderr || '').trim().split('\n')[0]}`,
);

// 病态输入的内容也不得丢失 —— 用户需要看到模型实际输出的内容。
const weird = renderMarkdown('```js" onload="alert(1)\ncode\n```');
check('病态输入的内容没有丢', weird.includes('code') && weird.includes('alert(1)'), weird);

// ── 5. 回归基准 ─────────────────────────────────────────

section('5. 回归锁（改坏了这里会立刻发现）');

const sample = renderMarkdown('## 标题\n\n段落带 `code`。\n\n- 一\n- 二\n');
check(
  '已知输入的输出保持稳定',
  // 说明：`##` 映射到 h3，h1 保留给页面自身的标题，因此整体下调一级。
  sample === '<h3>标题</h3><p>段落带 <code>code</code>。</p><ul><li>一</li><li>二</li></ul>',
  JSON.stringify(sample),
);

check('inline 只做行内替换', inline('**粗** 和 `码`') === '<strong>粗</strong> 和 <code>码</code>');

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
