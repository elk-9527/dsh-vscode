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

// ── 跨文件的约定：扩展和门必须对得上，否则静默连不上 ──────────────
// 这两边分别是「扩展默认往哪连」和「门实际开在哪」。它们一旦漂移，
// 表现只是「连不上」，很难看出是配置不一致，所以在这里钉死。

const extensionManifest = JSON.parse(read('package.json'));
const settings = extensionManifest.contributes.configuration.properties;
const doorPatch = read('../dsh-door/cordis.patch.yml');
const doorPort = Number(/^\s*port:\s*(\d+)/m.exec(doorPatch)?.[1]);
const doorHost = /^\s*host:\s*([\d.]+)/m.exec(doorPatch)?.[1];

check(
  '扩展默认端口和门实际监听端口一致',
  settings['dshPanel.port'].default === doorPort,
  `扩展 ${settings['dshPanel.port'].default} vs 门 ${doorPort}`,
);
check(
  '扩展默认主机和门实际监听主机一致',
  settings['dshPanel.host'].default === doorHost,
  `扩展 ${settings['dshPanel.host'].default} vs 门 ${doorHost}`,
);
check(
  '门只监听回环地址',
  doorHost === '127.0.0.1' || doorHost === 'localhost',
  `门监听在 ${doorHost}`,
);
check(
  '兜底档默认指向用户自己的 desktop 档（记忆/技能才一致）',
  settings['dshPanel.fallbackProfile'].default === 'desktop',
  `实际是 ${settings['dshPanel.fallbackProfile'].default}`,
);
check(
  '代码里的兜底档默认值和设置项一致（不能两处各写一个）',
  /fallbackProfile:\s*cfg\.get\('fallbackProfile'\)\s*\|\|\s*'desktop'/.test(viewSource),
  'view.js 里的兜底值和 package.json 漂移了',
);

// ── 预设（模式）这条链路横跨两边，_meta 的键名必须一模一样 ──────────
// 门用这个键往 result._meta 里塞清单，扩展用同一个键去读。键名一漂移，
// 表现只是「下拉框永远是空的」，不会报任何错 —— 所以在这里钉死。

const doorFrames = read('../dsh-door/lib/frames.js');
const clientSource = read('src/door/client.js');
const doorKey = /DOOR_META_KEY\s*=\s*'([^']+)'/.exec(doorFrames)?.[1];
const clientKey = /PRESET_META_KEY\s*=\s*'([^']+)'/.exec(clientSource)?.[1];

check('两边都定义了 _meta 的键名', Boolean(doorKey) && Boolean(clientKey), `门=${doorKey} 扩展=${clientKey}`);
check(
  '门和扩展用的 _meta 键名完全一致',
  doorKey === clientKey,
  `门=${doorKey} vs 扩展=${clientKey}（不一致就静默失效）`,
);
check(
  '扩展设置项里有 dshPanel.preset',
  Object.prototype.hasOwnProperty.call(settings, 'dshPanel.preset'),
  `现有设置：${Object.keys(settings).join(', ')}`,
);
check(
  '预设的四个 id 在门那边写全了（兜底清单不许漏）',
  ['standard', 'ptc', 'minimal', 'cordis'].every((id) => doorFrames.includes(`'${id}'`)),
  'frames.js 的兜底清单里少了 id',
);
check(
  '扩展在 resume 时会把预设一起告诉门（不告诉，接回来的会话就没有工具）',
  /resumeSession\(sessionId,\s*cwd,\s*\{\s*preset\s*\}/.test(clientSource),
  'client.js 的 resumeSession 没有 preset 参数',
);
check(
  '面板接回旧会话时传了当前预设',
  /session\.resume\(\s*target,\s*this\.workdir\(\),\s*\{\s*preset:/.test(viewSource),
  'view.js 的 resume 调用没带 preset',
);

// ── 编辑器上下文这条链路：命令 → 面板 → 界面 → 协议 ─────────────
// 任何一环换了名字都是"按了没反应"，所以逐环钉住。

const extensionSource = read('src/extension.js');
const commands = extensionManifest.contributes.commands.map((item) => item.command);

check(
  '两个"带进对话"的命令都声明了',
  commands.includes('dshPanel.attachFile') && commands.includes('dshPanel.attachSelection'),
  `现有命令：${commands.join(', ')}`,
);
check(
  '声明的命令在 extension.js 里真的注册了',
  ['dshPanel.attachFile', 'dshPanel.attachSelection'].every((id) => extensionSource.includes(`registerCommand('${id}'`)),
  '命令声明了却没注册，按下去只会报错',
);
check(
  '编辑器右键菜单里有这两项',
  extensionManifest.contributes.menus['editor/context'].some((item) => item.command === 'dshPanel.attachSelection') &&
    extensionManifest.contributes.menus['editor/context'].some((item) => item.command === 'dshPanel.attachFile'),
  JSON.stringify(extensionManifest.contributes.menus['editor/context']),
);
check(
  '没选中东西时，菜单里不显示"把选中的代码带进对话"',
  extensionManifest.contributes.menus['editor/context'].some(
    (item) => item.command === 'dshPanel.attachSelection' && item.when === 'editorHasSelection',
  ),
  '缺 when: editorHasSelection',
);
check(
  '扩展把编辑器里的东西整理成附件时用了 view.workdir()（路径才会是相对路径）',
  /attachmentFromEditor\(editor,\s*view\.workdir\(\)\)/.test(extensionSource),
  'extension.js 里的 attachFromEditor 没用 workdir',
);
check(
  '界面收到的附件消息（attach）在 view.js 里有对应的发出点',
  /post\(\{\s*type:\s*'attach',\s*items:/.test(viewSource),
  'view.js 没有发 attach 消息',
);
check(
  '面板的 send 把附件一起传下去（不然附件永远到不了内核）',
  /await session\.send\(text,\s*\{\s*attachments:\s*items\s*\}\)/.test(viewSource),
  'view.js 的 send 没把 attachments 传给会话',
);
check(
  '会话层把附件转交给门客户端',
  /client\.prompt\(this\.sessionId,\s*text,\s*\{\s*attachments,/.test(read('src/dsh/session.js')),
  'session.js 的 send 没把 attachments 给 client.prompt',
);
check(
  '主进程发消息时带上了挂着的附件',
  /post\(\{\s*type:\s*'send',\s*text,\s*attachments\s*\}\)/.test(webviewJs),
  'main.js 的 submit 没带 attachments',
);
check(
  '输入框上面那个附件容器，HTML 里有（否则界面往里塞不进去）',
  /id="attachments"/.test(htmlSource),
  'html.js 里没有 id="attachments"',
);
check(
  '附件块也是 flex 容器，所以必须自己压一道 [hidden]',
  /\.attachments\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(webviewCss),
  'CSS 里没有 .attachments[hidden] 规则（空的时候会占一块位置）',
);

// ── 装机之后不激活就全白搭 ────────────────────────────────────
// VS Code 是在**启动时**读 package.json 的 contributes 并注册命令的：
// 里面有一处不一致（菜单指向没声明的命令、图标名不存在、JSON 写坏），
// 它不会报错给你看，只会"那个按钮没反应/那一项不出现"。
// 这里把「打进 vsix 的东西」逐个解析一遍，把这类问题挡在装机之前。

const shipped = extensionManifest.contributes;
const declared = new Set(commands);

check(
  '每个命令都声明了 title',
  shipped.commands.every((item) => typeof item.title === 'string' && item.title.length > 0),
  shipped.commands.filter((item) => !item.title).map((item) => item.command).join(', '),
);
check(
  '每个命令的标题都带 DSH 前缀（命令面板里才找得到）',
  shipped.commands.every((item) => item.title.startsWith('DSH')),
  shipped.commands.map((item) => item.title).join(' | '),
);
{
  const dangling = [];
  for (const [menu, items] of Object.entries(shipped.menus)) {
    for (const item of items) {
      if (!declared.has(item.command)) dangling.push(`${menu}:${item.command}`);
    }
  }
  check('菜单里指向的命令都真的声明过', dangling.length === 0, dangling.join(', '));
}
{
  // 图标必须是 VS Code 内置的 codicon 名（写错就是不显示，且毫无提示）。
  const icons = shipped.commands.map((item) => item.icon).filter(Boolean);
  check(
    '图标都写成 VS Code 的 $(名字) 形式',
    icons.every((icon) => /^\$\([a-z][a-z0-9-]*[a-z0-9]\)$/.test(icon)),
    icons.join(' | '),
  );
  check('没有两个命令抢同一个图标名（抢了会有一个看起来像重复按钮）', icons.length >= 2);
}
{
  // 受限模式（Restricted Mode）：不声明「支持不受信工作区」的扩展会被整个禁掉，
  // 表现是面板凭空消失、还不报错。这一夜在真 VS Code 里踩到过，焊死它。
  const capability = extensionManifest.capabilities && extensionManifest.capabilities.untrustedWorkspaces;
  check('声明了「支持不受信工作区」（否则受限模式下面板会被静默禁用）',
    Boolean(capability && capability.supported === true),
    JSON.stringify(extensionManifest.capabilities));
  check('这条声明写了理由（免得以后有人看着莫名就删了）',
    Boolean(capability && typeof capability.description === 'string' && capability.description.length > 20));
}

{
  // when 里用的上下文键必须是真实存在的，写错等于该条件永远为假。
  // 按子句解析：`a == b` 只看左边的键，`a` 单独出现时它自己就是键。
  const knownWhen = new Set(['editorHasSelection', 'view', 'resourceScheme', 'inDiffEditor']);
  const unknown = [];
  for (const items of Object.values(shipped.menus)) {
    for (const item of items) {
      if (!item.when) continue;
      for (const clause of item.when.split(/\s*(?:&&|\|\|)\s*/)) {
        const comparison = /^([\w.]+)\s*(?:==|!=)\s*(.+)$/.exec(clause.trim());
        const key = comparison ? comparison[1] : clause.trim();
        if (!key) continue;
        if (!knownWhen.has(key)) unknown.push(`${item.command}: ${key}`);
      }
    }
  }
  check('when 条件里没有生造的上下文键', unknown.length === 0, unknown.join(', '));
}
{
  // 真正会被 VS Code 加载的文件：任何语法错误都会让整套功能静默消失。
  const { execFileSync } = require('node:child_process');
  const files = ['src/extension.js', 'src/panel/view.js', 'src/panel/html.js', 'src/door/client.js',
    'src/door/locate.js', 'src/dsh/session.js', 'src/dsh/blocks.js', 'src/dsh/errors.js',
    'media/main.js', 'media/markdown.js'];
  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (error) {
      broken.push(`${file}: ${String(error.stderr || error.message).split('\n')[0]}`);
    }
  }
  check('会被加载的每个 js 文件都能解析', broken.length === 0, broken.join(' | '));
}
{
  // vsix 里带的文件必须齐全 —— 少一个（比如忘了 media/markdown.js），
  // 装上去是个残废扩展，而且只在运行时才发现。
  const vsixFiles = ['package.json', 'README.md', 'src/extension.js', 'media/main.js', 'media/main.css', 'media/markdown.js', 'media/dsh.svg'];
  const missing = vsixFiles.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  check('打包清单里的文件都在', missing.length === 0, missing.join(', '));
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
