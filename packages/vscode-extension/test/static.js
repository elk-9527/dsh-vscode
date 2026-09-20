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
  // 2026-09-19 改的：默认档原来是 desktop，而那个档被桌面端独占、命令行起不来
  // （内核原话：profile "desktop" is managed exclusively by the Electron application）。
  // 也就是说"桌面端没开"的时候，面板必然起不来 —— 而那正是最需要它自己起来的时候。
  // 现在的默认值是面板自己的档 vscode-panel（从官方 web 模板建的，装了门）。
  '兜底档默认不是被桌面端独占的 desktop',
  settings['dshPanel.fallbackProfile'].default !== 'desktop',
  `实际是 ${settings['dshPanel.fallbackProfile'].default}`,
);
check(
  '代码里的兜底档默认值和设置项一致（不能两处各写一个）',
  viewSource.includes(`|| '${settings['dshPanel.fallbackProfile'].default}'`),
  `view.js 里的兜底值和 package.json（${settings['dshPanel.fallbackProfile'].default}）漂移了`,
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

// ── 权限预设这条链路：方法名跨两个包、标签跟桌面端对齐、清单不许写死 ──────
// 方法名漂移的表现是「顶栏那个权限按钮永远显示『切不了』」，不报任何错；
// 清单写死的表现是「用户装了插件，桌面端四档、面板只有三档」——
// 两种都很难从界面上看出根因，所以在这里钉死。

const doorPermission = read('../dsh-door/lib/permission.js');
const panelPermission = read('src/dsh/permission.js');
const doorGet = /PERMISSION_GET_METHOD\s*=\s*'([^']+)'/.exec(doorPermission)?.[1];
const doorSet = /PERMISSION_SET_METHOD\s*=\s*'([^']+)'/.exec(doorPermission)?.[1];

check(
  '门定义了权限的两个方法名',
  doorGet === 'dsh-door/permission/get' && doorSet === 'dsh-door/permission/set',
  `门=${doorGet} / ${doorSet}`,
);
check(
  '扩展调的就是门那两个方法名（写错一个字符就静默失效）',
  clientSource.includes(`'${doorGet}'`) && clientSource.includes(`'${doorSet}'`),
  'client.js 里的方法名和门对不上',
);
check(
  '权限方法挂在门的旁路前缀下（不会和内核/ACP 的方法名撞车）',
  /DOOR_PERMISSION_PREFIX\s*=\s*'dsh-door\/permission\/'/.test(doorPermission),
);
check(
  '门那边读的是客户端的会话 id（ACP 的 sessionId 就是内核的会话 id）',
  /params\.id/.test(doorPermission) || /raw\.id/.test(doorPermission),
);

// 内置三项的中文标签**跟桌面端逐字一致**（桌面端 i18n：
// access.preset.readOnly / workspaceWrite / fullAccess）。
// 这三行是「对着桌面端抄的」，抄错了就是同一个内核两种叫法，用户在两边会看懵。
check(
  '内置三项的中文标签跟桌面端一致',
  panelPermission.includes("'仅可查看'") &&
    panelPermission.includes("'工作区内修改'") &&
    panelPermission.includes("'完全权限'"),
  'src/dsh/permission.js 里的标签和桌面端的 access.preset.* 对不上',
);
check(
  '内置预设的 id 是内核那三个（kebab-case，别改成驼峰）',
  ['read-only', 'workspace-write', 'danger-full-access'].every((id) =>
    panelPermission.includes(`'${id}'`),
  ),
  '内置 id 少了或者写错了',
);
check(
  '完全权限必须带确认门（这一档点了就不再逐条问用户）',
  /NEEDS_CONFIRM\s*=\s*new Set\(\['danger-full-access'\]\)/.test(panelPermission),
  'danger-full-access 没有进 NEEDS_CONFIRM',
);
check(
  '面板**没有**把权限清单写死（插件加的 auto-approval 之类必须跟着内核出现）',
  // 允许出现在注释里（说明它从哪来），但不许出现在 BUILTIN 那张表里。
  !/'auto-approval'\s*:/.test(panelPermission),
  'src/dsh/permission.js 里出现了 auto-approval 的写死条目',
);
check(
  '面板问门要权限、而不是自己造一份（走 DoorClient 的两个方法）',
  /permissionGet\(sessionId\)/.test(clientSource) && /permissionSet\(sessionId,\s*value\)/.test(clientSource),
  'client.js 里没有 permissionGet/permissionSet，或没带会话 id',
);
check(
  '会话一定下来就去读一次权限（换内核/换会话都可能不一样）',
  /session\.on\('session'[\s\S]{0,220}refreshPermission\(\)/.test(viewSource),
  'view.js 的 wire() 里没有在 session 事件上刷新权限',
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
  // 兜底拉起的候选命令：设置里填的永远第一，默认安装位置其次，去重保序。
  // 这条链路修过一次「用户被迫先开桌面端」的毛病（裸 dsh 不在 PATH 上），
  // 焊死行为免得回退。
  const { dshCommandCandidates } = require(path.join(ROOT, 'src/door/locate.js'));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-candidates-'));
  const binDir = path.join(tmp, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'bin.js');
  fs.writeFileSync(bin, '// fake\n');

  const withBoth = dshCommandCandidates({ dshCommand: 'dsh', homedir: tmp });
  check('候选清单：设置里的命令排第一', withBoth[0] === 'dsh', withBoth.join(' | '));
  check('候选清单：默认安装位置会被发现（node bin.js）',
    withBoth.some((item) => item.startsWith('node ') && item.includes('bin.js')), withBoth.join(' | '));

  const onlyBin = dshCommandCandidates({ dshCommand: '', homedir: tmp });
  check('候选清单：设置填空也不至于没有候选', onlyBin.length === 1 && onlyBin[0].startsWith('node '), onlyBin.join(' | '));

  const noBin = dshCommandCandidates({ dshCommand: 'dsh', homedir: path.join(tmp, 'empty') });
  check('候选清单：默认位置不存在时不硬凑', noBin.length === 1 && noBin[0] === 'dsh', noBin.join(' | '));

  const dup = dshCommandCandidates({ dshCommand: `node ${bin}`, homedir: tmp });
  check('候选清单：重复命令去重', dup.length === 1, dup.join(' | '));
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  // 2026-09-19 那次「面板起不来」的根子：默认档是 desktop，而那个档被桌面端
  // 独占，命令行根本起不来。这里把两件事焊死：
  //   ① 能自动找到"装了门 + 网页档"的备选（不再死在写死的档名上）；
  //   ② 内核自己说了原因时，照实转述，别再用"多半是 PATH 不对"去盖过它。
  const { panelProfileCandidates, explainKernelFailure } = require(path.join(ROOT, 'src/door/locate.js'));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-profiles-'));
  const profiles = path.join(tmp, '.dsh', 'profiles');
  const writeProfile = (name, bundles) => {
    const dir = path.join(profiles, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${name}`,
      dsh: { profile: { bundles } },
    }));
  };
  // 面板自己的档：门 + 网页 + 一堆插件（最能干，应该排前面）
  writeProfile('vscode-panel', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-acp-door', 'dsh-context', 'modlens-x']);
  // 桌面端那个：同样有门和网页，但命令行起不来（我们没法从文件上看出来，只能试）
  writeProfile('desktop', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-acp-door']);
  // 给别的入口用的档：有门，但是 ACP 走标准输入输出那套 —— 不接受 --host/--port
  writeProfile('vscode', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', 'dsh-acp-door']);
  // 网页档但没装门 —— 起来了也没门可连
  writeProfile('web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

  const scanned = panelProfileCandidates({ configured: 'desktop', homedir: tmp, env: {} });
  check('候选档：设置里那个永远第一', scanned[0] === 'desktop', scanned.join(' | '));
  check('候选档：能自动发现装了门的网页档', scanned.includes('vscode-panel'), scanned.join(' | '));
  check('候选档：把 ACP 那种档排除掉（它不接受 --host/--port）', !scanned.includes('vscode'), scanned.join(' | '));
  check('候选档：没装门的网页档也排除', !scanned.includes('web'), scanned.join(' | '));
  check('候选档：有限的（最多三个，别让用户干等）', scanned.length <= 3, scanned.join(' | '));

  const noScan = panelProfileCandidates({ configured: 'vscode-panel', homedir: path.join(tmp, 'empty'), env: {} });
  check('候选档：没有 profiles 目录时也不崩，只留设置里那个',
    noScan.length === 1 && noScan[0] === 'vscode-panel', noScan.join(' | '));

  const managed = explainKernelFailure({
    profile: 'desktop',
    stderr: 'error: profile "desktop" is managed exclusively by the Electron application',
  });
  check('退出原因：认得出「这个档被桌面端独占」', managed.kind === 'app-managed-profile', managed.kind);
  /*
   * 2026-09-20 改：这句是**给用户看的**（错误卡片的"怎么办"），所以不再点名
   * fallbackProfile 这种设置项全名，也不提"档"。要求变成：说人话 + 指出出路。
   * 档名/设置项在紧随其后的原文段里（human.raw 的 tail），一个字不少。
   */
  check('退出原因：说人话（不出现档名 / 设置项全名）',
    !/desktop|fallbackProfile|档/.test(`${managed.reason} ${managed.advice}`),
    `${managed.reason}／${managed.advice}`);
  check('退出原因：指出出路（先开桌面端，或换一套配置）',
    /桌面端/.test(managed.advice) && /设置|配置/.test(managed.advice), managed.advice);
  check('退出原因：认得出「不接受面板的启动参数」',
    explainKernelFailure({ profile: 'vscode', stderr: "error: unknown option '--no-open'" }).kind === 'wrong-app-flags');
  check('退出原因：认得出「端口被占」',
    explainKernelFailure({ profile: 'x', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:47821' }).kind === 'port-in-use');
  check('退出原因：什么都没说时不硬猜（交给上层兜底）',
    explainKernelFailure({ profile: 'x', stderr: '' }).kind === 'unknown');
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  /*
   * 打包清单：清单本身在 tools/ship-list.js（打包、装机核对、发布前漂移检查共用），
   * 这里拴两件事 ——
   *   ① 清单里的东西**真的存在**（少一个文件，装上去就是残废扩展，只在运行时才发现）；
   *   ② 扩展目录下**每个顶层条目**要么在清单里、要么在 .vscodeignore 里 ——
   *      新加一个目录/文件却两边都没登记，市场包里就会多出（或少掉）东西。
   */
  const { SHIP, shipFiles } = require('../tools/ship-list');
  const missing = SHIP.filter((item) => !fs.existsSync(path.join(ROOT, item)));
  check('打包清单里的文件都在', missing.length === 0, missing.join(', '));
  check(
    '打包清单非空且逐个都展得开',
    shipFiles(ROOT).length >= SHIP.length,
    `${shipFiles(ROOT).length} 个文件`,
  );
  const ignore = read('.vscodeignore');
  const unlisted = fs
    .readdirSync(ROOT)
    .filter((name) => !SHIP.includes(name))
    .filter((name) => !new RegExp(`(^|\\n)\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\*|\\s|$)`).test(ignore));
  check('扩展目录里没有"既不在清单、也不在 .vscodeignore"的东西', unlisted.length === 0, unlisted.join(', '));
}

{
  /*
   * 内核死了要留下证据（2026-09-19 第二次踩）。
   *
   * 第一次踩的是「stderr 被扔了」→ 修好了，但那只是**收在内存里**，
   * 结果用户报"聊两句就断"的时候，面板日志里只有一句
   * `后台 DSH 退出了（code=1）`，内核为什么死一个字都没有。
   * 这一节拴住三件事：① 内核的输出要转进面板日志；② 它自己退出时
   * 要说清退出码 + 最后说的话（没说话也要说"没说话"）；③ 日志要限量。
   */
  const locate = read('src/door/locate.js');
  const view = read('src/panel/view.js');
  check('内核输出：stdout/stderr 都转进面板日志（能翻到原话）',
    /attach\(child\.stdout/.test(locate) && /attach\(child\.stderr/.test(locate) &&
      /内核\[\$\{which\}\]/.test(locate),
    'locate.js 里没看到转发');
  check('内核输出：两股都真的接着（stdio 不能把 stdout 设成 ignore）',
    !/stdio: \['ignore', 'ignore', 'pipe'\]/.test(locate) &&
      (locate.match(/stdio: \['ignore', 'pipe', 'pipe'\]/g) || []).length >= 2,
    'Windows 和 POSIX 两条 spawn 路径都要接 stdout');
  check('内核输出：限量（免得插件话多把日志刷爆）',
    /OUTPUT_LINE_CAP/.test(locate) && /OUTPUT_CHAR_CAP/.test(locate) &&
      /没记（超过/.test(locate));
  check('内核退出：说清是自己退的 + 退出码',
    /后台 DSH 自己退出了（code=/.test(locate));
  check('内核退出：把最后几行原话打出来', /它退之前最后说的话/.test(locate));
  check('内核退出：一个字没说的时候，明说「不是它自己崩的」',
    /一个字都没说就退了/.test(locate));
  check('断线：能分清「自己拉的内核死了」和「连的是别人的内核」',
    /disconnectText\(/.test(view) && /DSH 自己退出了（code=/.test(view) &&
      /那是别处的 DSH/.test(view));
  check('断线：告诉用户去哪儿看完整输出', /输出 → DSH Panel/.test(view));

  const logTool = path.join(ROOT, 'tools', 'panel-log.cjs');
  check('有个工具能把面板日志翻出来（不用自己翻 VS Code 日志目录）',
    fs.existsSync(logTool) && /DSH Panel\.log/.test(fs.readFileSync(logTool, 'utf8')));
}

{
  /*
   * 内核归谁、端口归谁（2026-09-19 的结构性修复，见 kernel-manager.js 开头）。
   *
   * 两条规矩，一条都不能回退：
   * ① **视图销毁 ≠ 内核死亡**：视图只是使用者，销毁只释放引用；只有宽限到期、
   *    窗口关闭、用户显式停 才真收。旧代码在 dispose 里 killTree，于是折叠侧边栏、
   *    拖面板、Reload Window 都变成一次"杀内核 + 重连"。
   * ② **端口归起内核的人定**：面板把 selfStartPort 写进环境变量
   *    DSH_ACP_DOOR_PORT，门优先读它；面板自启的内核不再去抢桌面端那个 47821。
   *    这个变量名在扩展和门两边各写了一次，必须逐字一致 —— 就是这条断言焊的。
   */
  const manager = read('src/panel/kernel-manager.js');
  const viewSource = read('src/panel/view.js');
  const extensionFile = read('src/extension.js');
  const doorPort = read('../dsh-door/lib/port.js');
  const doorIndex = read('../dsh-door/lib/index.js');

  check('内核归属：有一个专门管"谁在用、什么时候收"的模块',
    /class KernelManager/.test(manager) && /DEFAULT_IDLE_MS/.test(manager));
  check('内核归属：视图销毁只释放引用，不杀进程',
    /this\.kernels\.release\(this\)/.test(viewSource) &&
      !/this\.background\.dispose\(\)[\s\S]{0,80}\n  \}/.test(viewSource.slice(viewSource.indexOf('  dispose() {'))),
    'dispose() 里还看得见 background.dispose()');
  check('内核归属：宽限期来自设置（没设也有默认）',
    /kernelIdleMinutes/.test(viewSource) && /setIdleMs\(/.test(manager));
  check('内核归属：窗口关闭时收干净（deactivate）',
    /function deactivate\(\)[\s\S]{0,400}disposeAll\(/.test(extensionFile));
  check('内核归属：有"停掉后台内核"这条命令（用户能手动确认没留下进程）',
    /dshPanel\.stopKernel/.test(extensionFile) && /dshPanel\.stopKernel/.test(read('package.json')));

  const manifestPorts = JSON.parse(read('package.json')).contributes.configuration.properties;
  check('端口归谁：新增 dshPanel.selfStartPort，默认不是桌面端那个 47821',
    Number(manifestPorts['dshPanel.selfStartPort'].default) === 47831,
    String(manifestPorts['dshPanel.selfStartPort'] && manifestPorts['dshPanel.selfStartPort'].default));
  check('端口归谁：面板起内核时把端口钉进环境变量',
    /DSH_ACP_DOOR_PORT/.test(read('src/door/locate.js')) && /port: cfg\.selfStartPort/.test(viewSource));
  check('端口归谁：门也认这个环境变量（两边名字逐字一致）',
    /DSH_ACP_DOOR_PORT/.test(doorPort) && /resolveDoorPort/.test(doorIndex));
  check('端口归谁：门里的判定顺序是 环境变量 > 档配置 > 默认',
    /env\.DSH_ACP_DOOR_PORT[\s\S]{0,200}config\.port[\s\S]{0,120}DEFAULT_PORT/.test(doorPort));
  /*
   * 2026-09-20 改：这条从"写死盯着两个端口"变成"盯着 fallbackPorts 给的清单"——
   * 因为多了一个**只盯自己那个口**的例外（接上的那台换不了权限、改用自己启动的
   * 那台时；两个都盯会把设置里那个口上现成的旧门当成"新内核开好了"，又接回同一台）。
   * 两种清单都得在，而且默认那份必须还是两个口。
   */
  check('端口归谁：旧版门（不认环境变量）时也接得上 —— 默认两个端口都盯',
    /fallbackPorts\(cfg\)\s*\{[\s\S]{0,200}return \[cfg\.selfStartPort, cfg\.port\]/.test(viewSource) &&
      /waitForFallbackDoor\([\s\S]{0,220}this\.fallbackPorts\(cfg\)/.test(viewSource));
  check('端口归谁：换内核那条路只盯自己的口（不然会换回同一台）',
    /ownPortOnly[\s\S]{0,120}return \[cfg\.selfStartPort\]/.test(viewSource) &&
      /this\.ownPortOnly = true/.test(viewSource));

  const soak = path.join(ROOT, 'tools', 'soak.cjs');
  check('有个"连着干活十几分钟"的耐力测试（起得来但活不长这类毛病就靠它）',
    fs.existsSync(soak) && /turn-every/.test(fs.readFileSync(soak, 'utf8')));
  check('真窗口自检能多盯一段时间（DSH_PANEL_CHECK_LINGER）',
    /DSH_PANEL_CHECK_LINGER/.test(read('tools/vscode-check.js')));
}

{
  /*
   * 装机文件里不许有 UTF-8 BOM（2026-09-19 的事故，真炸过）。
   *
   * 我用 PowerShell 的 `Set-Content -Encoding UTF8` 改了门包的 package.json，
   * 它悄悄在前面加了 EF BB BF。`npm pack` 把这个 BOM 打进 tgz，装进用户档之后
   * 内核加载插件时 `JSON.parse` 直接抛 `SyntaxError: Unexpected token '﻿'` ——
   * `dsh plugin` 从此每次都崩，等于**我把用户那个档搞坏了**。
   * 这类事故必须有一条断言拦着：扩展自己的包、门包的 package.json 和 lib/ 全查。
   */
  const shippedFiles = [];
  const collect = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full, path.join(relative, entry.name));
      else if (/\.(js|cjs|mjs|json|css|html|yml|md)$/.test(entry.name)) {
        shippedFiles.push({ full, relative: path.join(relative, entry.name) });
      }
    }
  };
  collect(path.join(ROOT, 'src'), 'src');
  collect(path.join(ROOT, 'media'), 'media');
  shippedFiles.push({ full: path.join(ROOT, 'package.json'), relative: 'package.json' });
  shippedFiles.push({ full: path.join(ROOT, 'README.md'), relative: 'README.md' });
  shippedFiles.push({ full: path.join(ROOT, '..', 'dsh-door', 'package.json'), relative: 'dsh-door/package.json' });
  collect(path.join(ROOT, '..', 'dsh-door', 'lib'), 'dsh-door/lib');
  const bommed = shippedFiles.filter((item) => {
    const buf = fs.readFileSync(item.full);
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  });
  check(`装机文件里没有 UTF-8 BOM（查了 ${shippedFiles.length} 个；BOM 会让 JSON.parse 崩掉整个档）`,
    bommed.length === 0, bommed.map((item) => item.relative).join(', '));
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
