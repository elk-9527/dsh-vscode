'use strict';

/**
 * 静态契约测试：不加不减地读源码，检查三件很容易悄悄坏掉的事。
 *
 * 1. 界面里的 `getElementById('x')` —— HTML 里真的有 id="x" 吗？
 *    （写错一个字母，那个控件就是死的，而且界面上完全看不出来）
 * 2. 扩展发的每种消息，界面都处理了吗？界面发的每种，扩展都处理了吗？
 *    （数字/字符串拼错 → 静默丢消息，最难查的一类 bug）
 * 3. main.js 里用到的每个 CSS 类，样式表里都有吗？
 *
 * 这个测试不需要 DSH、不需要网络、不需要编辑器，随时能跑。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const htmlSource = read('src/panel/html.js');
const webviewJs = read('media/main.js');
const webviewCss = read('media/main.css');
const viewSource = read('src/panel/view.js');

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

function unique(list) {
  return [...new Set(list)];
}

/** 把 `${...}` 插值抠掉，免得模板里的动态内容干扰解析。 */
function stripInterpolations(text) {
  return text.replace(/\$\{[^}]*\}/g, '');
}

// ── 1. HTML 的 id 与界面代码对得上吗 ─────────────────────

section('1. HTML id ↔ getElementById');

const htmlIds = unique([...htmlSource.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const usedIds = unique([...webviewJs.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]));

console.log(`     HTML 定义了 ${htmlIds.length} 个 id：${htmlIds.join(', ')}`);

const missingIds = usedIds.filter((id) => !htmlIds.includes(id));
check(
  '界面要的每个 id 都在 HTML 里',
  missingIds.length === 0,
  missingIds.length ? `HTML 里没有：${missingIds.join(', ')}` : '',
);

const unusedIds = htmlIds.filter((id) => !usedIds.includes(id));
if (unusedIds.length > 0) {
  console.log(`     （HTML 里这几个 id 界面代码没用到：${unusedIds.join(', ')}）`);
}

// ── 2. 消息契约 ─────────────────────────────────────────

section('2. 消息契约（扩展 ↔ 界面）');

/** 从 `.post({ type: 'x' })` / `post({ type: 'x' })` 里提取消息名。 */
function postedTypes(source, receiverPattern) {
  const pattern = new RegExp(`${receiverPattern}\\(\\{[^}]*?type:\\s*'([^']+)'`, 'g');
  return unique([...source.matchAll(pattern)].map((match) => match[1]));
}

const extensionPosts = postedTypes(viewSource, 'this\\.post');
const webviewHandles = unique([...webviewJs.matchAll(/case '([^']+)':/g)].map((match) => match[1]));

console.log(`     扩展发出：${extensionPosts.join(', ')}`);
console.log(`     界面处理：${webviewHandles.join(', ')}`);

const unhandled = extensionPosts.filter((type) => !webviewHandles.includes(type));
check(
  '扩展发出的每种消息，界面都处理了',
  unhandled.length === 0,
  unhandled.length ? `界面没有 case：${unhandled.join(', ')}` : '',
);

const webviewPosts = postedTypes(webviewJs, 'post');
const extensionHandles = unique(
  [...viewSource.matchAll(/case '([^']+)':/g)].map((match) => match[1]),
);

console.log(`     界面发出：${webviewPosts.join(', ')}`);
console.log(`     扩展处理：${extensionHandles.join(', ')}`);

const unhandledByExtension = webviewPosts.filter((type) => !extensionHandles.includes(type));
check(
  '界面发出的每种消息，扩展都处理了',
  unhandledByExtension.length === 0,
  unhandledByExtension.length ? `扩展没有 case：${unhandledByExtension.join(', ')}` : '',
);

// ── 3. CSS 类 ───────────────────────────────────────────

section('3. main.js 用到的 CSS 类 ↔ main.css');

const cssClasses = unique([...webviewCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));

const usedClasses = unique(
  [
    // class="a b c"
    ...[...stripInterpolations(webviewJs).matchAll(/class="([^"]*)"/g)].flatMap((match) =>
      match[1].split(/\s+/),
    ),
    // className = 'a b c'
    ...[...webviewJs.matchAll(/className\s*=\s*'([^']*)'/g)].flatMap((match) => match[1].split(/\s+/)),
    // classList.add('x')
    ...[...webviewJs.matchAll(/classList\.add\('([^']+)'\)/g)].map((match) => match[1]),
  ]
    .map((name) => name.trim())
    .filter(Boolean),
);

const missingClasses = usedClasses.filter(
  // 以 `-` 结尾的是动态前缀（例如 class="language-${lang}" 被抠掉插值后的残留），不算缺失。
  (name) => name && !name.endsWith('-') && !cssClasses.includes(name),
);
check(
  '用到的每个 CSS 类都有样式',
  missingClasses.length === 0,
  missingClasses.length ? `样式表里没有：${missingClasses.join(', ')}` : '',
);
console.log(`     main.js 用到 ${usedClasses.length} 个类，样式表里有 ${cssClasses.length} 个`);

// ── 4. 其它静态约束 ─────────────────────────────────────

section('4. 其它不该犯的错');

// 所有 innerHTML 赋值都必须经过「先转义」的渲染函数 —— 这是防注入的最后一道闸。
const innerHtmlAssignments = [...webviewJs.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((match) =>
  match[1].trim(),
);
const unsafeInnerHtml = innerHtmlAssignments.filter(
  (right) => right !== "''" && !/^(renderMarkdown|renderToolBody|caret)\(/.test(right),
);
check(
  '所有 innerHTML 赋值都走转义函数',
  unsafeInnerHtml.length === 0,
  unsafeInnerHtml.join(' | '),
);
check(
  '扩展里没有硬编码的颜色值（颜色一律走主题变量）',
  // 连 rgb()/hsl() 一起禁掉：只要写死颜色，换主题时就会露馅。
  !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(webviewCss.replace(/\/\*[\s\S]*?\*\//g, '')),
  'CSS 里出现了写死的颜色',
);
check('package.json 的 main 指向真实文件', fs.existsSync(path.join(ROOT, 'src/extension.js')));
check('活动栏图标存在', fs.existsSync(path.join(ROOT, 'media/dsh.svg')));
check(
  '图标用 currentColor 上色（才能跟随主题）',
  /currentColor/.test(read('media/dsh.svg')),
);

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
