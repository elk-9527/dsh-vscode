'use strict';

/**
 * 静态契约测试：以不增不减的方式读取源码，检查三类容易在无察觉的情况下失效的问题。
 *
 * 1. 界面中的 `getElementById('x')` —— 检查 HTML 中确实存在 id="x"
 *    （写错一个字母，该控件即失效，且界面上完全无法察觉）
 * 2. 检查扩展发送的每种消息界面是否都处理，以及界面发送的每种消息扩展是否都处理
 *    （数字/字符串拼错即静默丢弃消息，属于最难排查的一类缺陷）
 * 3. 检查 main.js 中使用到的每个 CSS 类在样式表中都存在
 *
 * 该测试不需要 DSH、不需要网络、不需要编辑器，可随时运行。
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

/** 移除 `${...}` 插值，避免模板中的动态内容干扰解析。 */
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
  '界面所需的每个 id 都在 HTML 中',
  missingIds.length === 0,
  missingIds.length ? `HTML 里没有：${missingIds.join(', ')}` : '',
);

const unusedIds = htmlIds.filter((id) => !usedIds.includes(id));
if (unusedIds.length > 0) {
  console.log(`     （HTML 中以下 id 界面代码未使用：${unusedIds.join(', ')}）`);
}

// ── 2. 消息契约 ─────────────────────────────────────────

section('2. 消息契约（扩展 ↔ 界面）');

/** 从 `.post({ type: 'x' })` / `post({ type: 'x' })` 中提取消息名。 */
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
  '扩展发出的每种消息，界面均处理',
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
  '界面发出的每种消息，扩展均处理',
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
  // 以 `-` 结尾的是动态前缀（例如 class="language-${lang}" 移除插值后的残留），不计为缺失。
  (name) => name && !name.endsWith('-') && !cssClasses.includes(name),
);
check(
  '使用到的每个 CSS 类都有对应样式',
  missingClasses.length === 0,
  missingClasses.length ? `样式表里没有：${missingClasses.join(', ')}` : '',
);
console.log(`     main.js 用到 ${usedClasses.length} 个类，样式表里有 ${cssClasses.length} 个`);

// ── 4. 其它静态约束 ─────────────────────────────────────

section('4. 其它不该犯的错');

// 所有 innerHTML 赋值都必须经过「先转义」的渲染函数 —— 这是防注入的最后一道防线。
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
  '扩展中没有硬编码的颜色值（颜色一律使用主题变量）',
  // 连同 rgb()/hsl() 一并禁止：一旦写死颜色，切换主题时即会显现。
  !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(webviewCss.replace(/\/\*[\s\S]*?\*\//g, '')),
  'CSS 中出现了硬编码的颜色',
);
check('package.json 的 main 指向真实文件', fs.existsSync(path.join(ROOT, 'src/extension.js')));
check('活动栏图标存在', fs.existsSync(path.join(ROOT, 'media/dsh.svg')));
check(
  '图标使用 currentColor 上色（以便跟随主题）',
  /currentColor/.test(read('media/dsh.svg')),
);

// ── 跨文件的约定：扩展与该插件必须一致，否则会静默连接失败 ──────────────
// 两边分别是「扩展默认连接位置」与「该插件实际监听位置」。二者一旦不一致，
// 表现为「无法连接」，难以判断是配置不一致，因此在此固定。

const extensionManifest = JSON.parse(read('package.json'));
const settings = extensionManifest.contributes.configuration.properties;
const doorPatch = read('../dsh-door/cordis.patch.yml');
const doorPort = Number(/^\s*port:\s*(\d+)/m.exec(doorPatch)?.[1]);
const doorHost = /^\s*host:\s*([\d.]+)/m.exec(doorPatch)?.[1];

check(
  '扩展默认端口与该插件实际监听端口一致',
  settings['dshPanel.port'].default === doorPort,
  `扩展 ${settings['dshPanel.port'].default} vs 该插件 ${doorPort}`,
);
check(
  '扩展默认主机与该插件实际监听主机一致',
  settings['dshPanel.host'].default === doorHost,
  `扩展 ${settings['dshPanel.host'].default} vs 该插件 ${doorHost}`,
);
check(
  '该插件只监听回环地址',
  doorHost === '127.0.0.1' || doorHost === 'localhost',
  `该插件监听在 ${doorHost}`,
);
check(
  // 2026-09-19 修改：默认档原为 desktop，而该档被桌面端独占，命令行无法启动
  // （内核原话：profile "desktop" is managed exclusively by the Electron application）。
  // 即「桌面端未启动」时面板必然无法启动 —— 而这正是最需要它自行启动的场景。
  // 当前默认值为面板自身的档 vscode-panel（由官方 web 模板创建，已安装该插件）。
  '后备档默认不是被桌面端独占的 desktop',
  settings['dshPanel.fallbackProfile'].default !== 'desktop',
  `实际是 ${settings['dshPanel.fallbackProfile'].default}`,
);
check(
  '代码里的后备档默认值与设置项一致（不得两处各写一份）',
  viewSource.includes(`|| '${settings['dshPanel.fallbackProfile'].default}'`),
  `view.js 里的后备值与 package.json（${settings['dshPanel.fallbackProfile'].default}）不一致`,
);

// ── 预设（模式）这条链路横跨两边，_meta 的键名必须完全一致 ──────────
// 该插件使用该键将清单写入 result._meta，扩展使用同一个键读取。键名一旦不一致，
// 表现为「下拉框始终为空」，不会产生任何报错；因此在此固定。

const doorFrames = read('../dsh-door/lib/frames.js');
const clientSource = read('src/door/client.js');
const doorKey = /DOOR_META_KEY\s*=\s*'([^']+)'/.exec(doorFrames)?.[1];
const clientKey = /PRESET_META_KEY\s*=\s*'([^']+)'/.exec(clientSource)?.[1];

check('两边都定义了 _meta 的键名', Boolean(doorKey) && Boolean(clientKey), `该插件=${doorKey} 扩展=${clientKey}`);
check(
  '该插件和扩展使用的 _meta 键名完全一致',
  doorKey === clientKey,
  `该插件=${doorKey} vs 扩展=${clientKey}（不一致即静默失效）`,
);
check(
  '扩展设置项里有 dshPanel.preset',
  Object.prototype.hasOwnProperty.call(settings, 'dshPanel.preset'),
  `现有设置：${Object.keys(settings).join(', ')}`,
);
check(
  '预设的四个 id 在插件侧写全了（后备清单不得遗漏）',
  ['standard', 'ptc', 'minimal', 'cordis'].every((id) => doorFrames.includes(`'${id}'`)),
  'frames.js 的后备清单里缺少 id',
);
check(
  '扩展在 resume 时一并告知该插件预设（否则接回的会话没有工具）',
  /resumeSession\(sessionId,\s*cwd,\s*\{\s*preset\s*\}/.test(clientSource),
  'client.js 的 resumeSession 没有 preset 参数',
);
check(
  '面板接回旧会话时传递了当前预设',
  /session\.resume\(\s*target,\s*this\.workdir\(\),\s*\{\s*preset:/.test(viewSource),
  'view.js 的 resume 调用没带 preset',
);

// ── 权限预设这条链路：方法名跨两个包、标签与桌面端对齐、清单不得写死 ──────
// 方法名不一致时表现为「顶栏权限按钮始终显示『不可切换』」，且不产生任何报错；
// 清单写死时表现为「用户安装插件后，桌面端四档、面板只有三档」——
// 两种情况都难以从界面上判断根因，因此在此固定。

const doorPermission = read('../dsh-door/lib/permission.js');
const panelPermission = read('src/dsh/permission.js');
const doorGet = /PERMISSION_GET_METHOD\s*=\s*'([^']+)'/.exec(doorPermission)?.[1];
const doorSet = /PERMISSION_SET_METHOD\s*=\s*'([^']+)'/.exec(doorPermission)?.[1];

check(
  '该插件定义了权限的两个方法名',
  doorGet === 'dsh-door/permission/get' && doorSet === 'dsh-door/permission/set',
  `该插件=${doorGet} / ${doorSet}`,
);
check(
  '扩展调用的就是该插件那两个方法名（写错一个字符即静默失效）',
  clientSource.includes(`'${doorGet}'`) && clientSource.includes(`'${doorSet}'`),
  'client.js 里的方法名与该插件不一致',
);
check(
  '权限方法挂在该插件的旁路前缀下（不影响内核/ACP 的方法名）',
  /DOOR_PERMISSION_PREFIX\s*=\s*'dsh-door\/permission\/'/.test(doorPermission),
);
check(
  '该插件读取的是客户端的会话 id（ACP 的 sessionId 即内核的会话 id）',
  /params\.id/.test(doorPermission) || /raw\.id/.test(doorPermission),
);

// 内置三项的中文标签**与桌面端逐字一致**（桌面端 i18n：
// access.preset.readOnly / workspaceWrite / fullAccess）。
// 这三行与桌面端保持一致；若不一致，同一内核会出现两种名称，
// 用户在两处看到的结果不同。
check(
  '内置三项的中文标签与桌面端一致',
  panelPermission.includes("'仅可查看'") &&
    panelPermission.includes("'工作区内修改'") &&
    panelPermission.includes("'完全权限'"),
  'src/dsh/permission.js 里的标签和桌面端的 access.preset.* 对不上',
);
check(
  '内置预设的 id 是内核那三个（kebab-case，不得改为驼峰）',
  ['read-only', 'workspace-write', 'danger-full-access'].every((id) =>
    panelPermission.includes(`'${id}'`),
  ),
  '内置 id 少了或者写错了',
);
check(
  '完全权限必须附带确认步骤（该档位启用后不再逐条请求确认）',
  /NEEDS_CONFIRM\s*=\s*new Set\(\['danger-full-access'\]\)/.test(panelPermission),
  'danger-full-access 没有进 NEEDS_CONFIRM',
);
check(
  '面板**没有**把权限清单写死（插件添加的 auto-approval 等项必须随内核出现）',
  // 允许出现在注释中（说明其来源），但不得出现在 BUILTIN 表中。
  !/'auto-approval'\s*:/.test(panelPermission),
  'src/dsh/permission.js 里出现了 auto-approval 的写死条目',
);
check(
  '面板向该插件请求权限数据，而不是自行构造一份（走 DoorClient 的两个方法）',
  /permissionGet\(sessionId\)/.test(clientSource) && /permissionSet\(sessionId,\s*value\)/.test(clientSource),
  'client.js 里没有 permissionGet/permissionSet，或没带会话 id',
);
check(
  '会话一定下来就去读一次权限（换内核/换会话都可能不一样）',
  /session\.on\('session'[\s\S]{0,220}refreshPermission\(\)/.test(viewSource),
  'view.js 的 wire() 里没有在 session 事件上刷新权限',
);

// 错误码同样是一份跨包契约，且比方法名更容易出错：客户端依据**码**分档（不再对该插件的
// 中文原文做正则匹配）。数值相差一位，表现为「该选项已不存在」被说成
// 「无法读取当前权限 / 请点击重新连接后重试」—— 而重连无法修复该问题。
const doorErrOther = /DOOR_ERR_OTHER\s*=\s*(-\d+)/.exec(doorPermission)?.[1];
const doorErrPreset = /DOOR_ERR_UNKNOWN_PRESET\s*=\s*(-\d+)/.exec(doorPermission)?.[1];
const doorErrSession = /DOOR_ERR_NO_SESSION\s*=\s*(-\d+)/.exec(doorPermission)?.[1];
const panelErrPreset = /UNKNOWN_PRESET:\s*(-\d+)/.exec(panelPermission)?.[1];
const panelErrSession = /NO_SESSION:\s*(-\d+)/.exec(panelPermission)?.[1];
check(
  '该插件定义了「名字不存在」「会话不存在」两个码，且与 -32000 不是同一个数',
  Boolean(doorErrPreset) && Boolean(doorErrSession) && doorErrOther === '-32000' &&
    new Set([doorErrOther, doorErrPreset, doorErrSession]).size === 3,
  `其它=${doorErrOther} 名字=${doorErrPreset} 会话=${doorErrSession}`,
);
check(
  '扩展识别的码与该插件发送的码一致（差值一位即会分错类别）',
  panelErrPreset === doorErrPreset && panelErrSession === doorErrSession,
  `该插件=${doorErrPreset}/${doorErrSession} 扩展=${panelErrPreset}/${panelErrSession}`,
);
check(
  '该插件为这两种失败附加了各自的码（缺少该标记则全部落入 -32000）',
  /permissionError\(\s*\n?\s*DOOR_ERR_UNKNOWN_PRESET/.test(read('../dsh-door/lib/index.js')) &&
    /permissionError\(\s*\n?\s*DOOR_ERR_NO_SESSION/.test(read('../dsh-door/lib/index.js')),
  'dsh-door/lib/index.js 里没给 resolve()/会话查找打码',
);

// custom 是内核推导出的**展示状态**（附在清单末尾），不是可切换的目标：内核的
// resolve() 对它直接抛出异常。桌面端将其滤出可选行，此处固定面板同样将其标出 ——
// 遗漏时表现为「点击当前项后提示无法读取当前权限」。
check(
  '扩展把 custom 标成展示项（selectable: false）',
  /DISPLAY_ONLY\s*=\s*new Set\(\['custom'\]\)/.test(panelPermission) &&
    /selectable:\s*!DISPLAY_ONLY\.has\(value\)/.test(panelPermission),
  'src/dsh/permission.js 里没有 DISPLAY_ONLY 或没接进 decorateOptions',
);
check(
  '界面不为展示项绑定点击，点击也不发送消息（渲染层与 chooseAccess 两道）',
  webviewJs.includes('if (option.selectable === false) {') &&
    webviewJs.includes('if (!option || option.selectable === false) return;'),
  'media/main.js 里少了一道 selectable 判定',
);
check(
  '发送之前由扩展再拦截一道（应对 webview 仍为旧 bundle 的混搭情况）',
  /DISPLAY_ONLY\.has\(wanted\)/.test(viewSource),
  'panel/view.js 的 setPermission() 没挡展示项',
);

// ── 编辑器上下文这条链路：命令 → 面板 → 界面 → 协议 ─────────────
// 任何一环改名都会表现为「按下后无反应」，因此逐环固定。

const extensionSource = read('src/extension.js');
const commands = extensionManifest.contributes.commands.map((item) => item.command);

check(
  '两个「带进对话」命令均已声明',
  commands.includes('dshPanel.attachFile') && commands.includes('dshPanel.attachSelection'),
  `现有命令：${commands.join(', ')}`,
);
check(
  '声明的命令在 extension.js 中确实注册了',
  ['dshPanel.attachFile', 'dshPanel.attachSelection'].every((id) => extensionSource.includes(`registerCommand('${id}'`)),
  '命令声明了却没注册，按下去只会报错',
);
check(
  '编辑器右键菜单中包含这两项',
  extensionManifest.contributes.menus['editor/context'].some((item) => item.command === 'dshPanel.attachSelection') &&
    extensionManifest.contributes.menus['editor/context'].some((item) => item.command === 'dshPanel.attachFile'),
  JSON.stringify(extensionManifest.contributes.menus['editor/context']),
);
check(
  '未选中内容时，菜单中不显示「把选中的代码带进对话」',
  extensionManifest.contributes.menus['editor/context'].some(
    (item) => item.command === 'dshPanel.attachSelection' && item.when === 'editorHasSelection',
  ),
  '缺 when: editorHasSelection',
);
check(
  '扩展将编辑器内容整理为附件时使用了 view.workdir()（路径才会是相对路径）',
  /attachmentFromEditor\(editor,\s*view\.workdir\(\)\)/.test(extensionSource),
  'extension.js 里的 attachFromEditor 没用 workdir',
);
check(
  '界面收到的附件消息（attach）在 view.js 中有对应的发出点',
  /post\(\{\s*type:\s*'attach',\s*items:/.test(viewSource),
  'view.js 没有发 attach 消息',
);
check(
  '面板的 send 一并传递附件（否则附件无法到达内核）',
  /await session\.send\(text,\s*\{\s*attachments:\s*items\s*\}\)/.test(viewSource),
  'view.js 的 send 没把 attachments 传给会话',
);
check(
  '会话层将附件转交给该插件客户端',
  /client\.prompt\(this\.sessionId,\s*text,\s*\{\s*attachments,/.test(read('src/dsh/session.js')),
  'session.js 的 send 没把 attachments 给 client.prompt',
);
check(
  '主进程发送消息时带上了已挂载的附件',
  /post\(\{\s*type:\s*'send',\s*text,\s*attachments\s*\}\)/.test(webviewJs),
  'main.js 的 submit 没带 attachments',
);
check(
  '输入框上方的附件容器在 HTML 中存在（否则界面无法写入）',
  /id="attachments"/.test(htmlSource),
  'html.js 里没有 id="attachments"',
);
check(
  '附件块同为 flex 容器，因此必须自行覆盖 [hidden]',
  /\.attachments\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(webviewCss),
  'CSS 里没有 .attachments[hidden] 规则（空的时候会占一块位置）',
);

// ── 装机之后不激活则全部无效 ────────────────────────────────────
// VS Code 在**启动时**读取 package.json 的 contributes 并注册命令：
// 其中任一处理不一致（菜单指向未声明的命令、图标名不存在、JSON 损坏），
// 都不会报错，只表现为「按钮无反应 / 选项不出现」。
// 此处将「打进 vsix 的内容」逐个解析，把这类问题拦截在装机之前。

const shipped = extensionManifest.contributes;
const declared = new Set(commands);

check(
  '每个命令都声明了 title',
  shipped.commands.every((item) => typeof item.title === 'string' && item.title.length > 0),
  shipped.commands.filter((item) => !item.title).map((item) => item.command).join(', '),
);
check(
  '每个命令的标题均带 DSH 前缀（命令面板中才能找到）',
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
  check('菜单中指向的命令均已声明', dangling.length === 0, dangling.join(', '));
}
{
  // 图标必须为 VS Code 内置的 codicon 名称（写错则不显示，且没有任何提示）。
  const icons = shipped.commands.map((item) => item.icon).filter(Boolean);
  check(
    '图标均写成 VS Code 的 $(名字) 形式',
    icons.every((icon) => /^\$\([a-z][a-z0-9-]*[a-z0-9]\)$/.test(icon)),
    icons.join(' | '),
  );
  check('没有两个命令共用同一个图标名（共用时其中一个会看起来像重复按钮）', icons.length >= 2);
}
{
  // 受限模式（Restricted Mode）：未声明「支持不受信工作区」的扩展会被整体禁用，
  // 表现为面板消失且不报错。该问题曾在真实 VS Code 中遇到，此处固定。
  const capability = extensionManifest.capabilities && extensionManifest.capabilities.untrustedWorkspaces;
  check('声明了「支持不受信工作区」（否则受限模式下面板会被静默禁用）',
    Boolean(capability && capability.supported === true),
    JSON.stringify(extensionManifest.capabilities));
  check('该声明写明了理由（避免后续被无意删除）',
    Boolean(capability && typeof capability.description === 'string' && capability.description.length > 20));
}

{
  // when 中使用的上下文键必须真实存在，写错则等价于该条件恒为假。
  // 按子句解析：`a == b` 只取左侧的键，`a` 单独出现时其自身即为键。
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
  check('when 条件中没有生造的上下文键', unknown.length === 0, unknown.join(', '));
}
{
  // 实际会被 VS Code 加载的文件：任何语法错误都会使整套功能静默失效。
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
  // 用于后备拉起的候选命令：设置中填写的始终排第一，默认安装位置其次，去重并保持顺序。
  // 这条链路曾修复「用户被迫先启动桌面端」的问题（直接给出的 dsh 不在 PATH 上），
  // 固定其行为以免回退。
  const { dshCommandCandidates } = require(path.join(ROOT, 'src/door/locate.js'));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-candidates-'));
  const binDir = path.join(tmp, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'bin.js');
  fs.writeFileSync(bin, '// fake\n');

  const withBoth = dshCommandCandidates({ dshCommand: 'dsh', homedir: tmp });
  check('候选清单：设置中的命令排第一', withBoth[0] === 'dsh', withBoth.join(' | '));
  check('候选清单：默认安装位置会被发现（node bin.js）',
    withBoth.some((item) => item.startsWith('node ') && item.includes('bin.js')), withBoth.join(' | '));

  const onlyBin = dshCommandCandidates({ dshCommand: '', homedir: tmp });
  check('候选清单：设置为空时也不至于没有候选', onlyBin.length === 1 && onlyBin[0].startsWith('node '), onlyBin.join(' | '));

  const noBin = dshCommandCandidates({ dshCommand: 'dsh', homedir: path.join(tmp, 'empty') });
  check('候选清单：默认位置不存在时不额外添加', noBin.length === 1 && noBin[0] === 'dsh', noBin.join(' | '));

  const dup = dshCommandCandidates({ dshCommand: `node ${bin}`, homedir: tmp });
  check('候选清单：重复命令去重', dup.length === 1, dup.join(' | '));
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  // 2026-09-19 那次「面板无法启动」的根因：默认档为 desktop，而该档被桌面端
  // 独占，命令行无法启动。此处固定两件事：
  //   ① 能自动找到「已安装该插件 + 网页档」的备选（不再依赖写死的档名）；
  //   ② 内核自身给出原因时如实转述，不再用「多半是 PATH 不对」覆盖它。
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
  // 面板自身的档：该插件 + 网页 + 一组插件（能力最完整，应排在前面）
  writeProfile('vscode-panel', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-acp-door', 'dsh-context', 'modlens-x']);
  // 桌面端的档：同样有该插件和网页，但命令行无法启动（无法从文件上判断，只能尝试）
  writeProfile('desktop', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-acp-door']);
  // 供其他入口使用的档：有该插件，但 ACP 走标准输入输出，不接受 --host/--port
  writeProfile('vscode', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', 'dsh-acp-door']);
  // 网页档但未安装该插件 —— 即使启动成功也没有该插件可连接
  writeProfile('web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

  const scanned = panelProfileCandidates({ configured: 'desktop', homedir: tmp, env: {} });
  check('候选档：设置中的档始终第一', scanned[0] === 'desktop', scanned.join(' | '));
  check('候选档：能自动发现已安装该插件的网页档', scanned.includes('vscode-panel'), scanned.join(' | '));
  check('候选档：排除 ACP 那类档（它不接受 --host/--port）', !scanned.includes('vscode'), scanned.join(' | '));
  check('候选档：未安装该插件的网页档同样排除', !scanned.includes('web'), scanned.join(' | '));
  check('候选档：数量有限（最多三个，避免用户长时间等待）', scanned.length <= 3, scanned.join(' | '));

  const noScan = panelProfileCandidates({ configured: 'vscode-panel', homedir: path.join(tmp, 'empty'), env: {} });
  check('候选档：没有 profiles 目录时也不出错，只保留设置中的那个',
    noScan.length === 1 && noScan[0] === 'vscode-panel', noScan.join(' | '));

  const managed = explainKernelFailure({
    profile: 'desktop',
    stderr: 'error: profile "desktop" is managed exclusively by the Electron application',
  });
  check('退出原因：能识别「该档被桌面端独占」', managed.kind === 'app-managed-profile', managed.kind);
  /*
   * 2026-09-20 修改：该句**面向用户**（错误卡片的「如何处理」），因此不再直接写出
   * fallbackProfile 这类设置项全名，也不提「档」。要求为：使用可理解的表述 + 指出处理途径。
   * 档名与设置项位于紧随其后的原文段中（human.raw 的 tail），不删减任何字符。
   */
  check('退出原因：使用面向用户的表述（不出现档名 / 设置项全名）',
    !/desktop|fallbackProfile|档/.test(`${managed.reason} ${managed.advice}`),
    `${managed.reason}／${managed.advice}`);
  check('退出原因：指出处理途径（先启动桌面端，或更换一套配置）',
    /桌面端/.test(managed.advice) && /设置|配置/.test(managed.advice), managed.advice);
  check('退出原因：能识别「不接受面板的启动参数」',
    explainKernelFailure({ profile: 'vscode', stderr: "error: unknown option '--no-open'" }).kind === 'wrong-app-flags');
  check('退出原因：能识别「端口被占用」',
    explainKernelFailure({ profile: 'x', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:47821' }).kind === 'port-in-use');
  check('退出原因：没有任何信息时不作推测（交由上层提供后备）',
    explainKernelFailure({ profile: 'x', stderr: '' }).kind === 'unknown');
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  /*
   * 打包清单：清单本身位于 tools/ship-list.js（打包、装机核对、发布前漂移检查共用），
   * 此处固定两件事 ——
   *   ① 清单中的条目**确实存在**（缺少一个文件，装上去即为残缺扩展，仅在运行时才发现）；
   *   ② 扩展目录下**每个顶层条目**要么在清单中、要么在 .vscodeignore 中 ——
   *      新增目录或文件却两处都未登记时，市场包中会多出（或缺少）内容。
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
  check('扩展目录中没有「既不在清单、也不在 .vscodeignore」的条目', unlisted.length === 0, unlisted.join(', '));
}

{
  /*
   * 内核终止时需要留下证据（2026-09-19 第二次遇到）。
   *
   * 第一次遇到的问题是「stderr 被丢弃」→ 已修复，但输出仅**保存在内存中**，
   * 因此用户反馈「对话几轮后断开」时，面板日志中只有一句
   * `后台 DSH 退出了（code=1）`，没有任何关于内核终止原因的信息。
   * 本节固定三件事：① 内核输出需转发到面板日志；② 其自行退出时需说明
   * 退出码与最后的输出（无输出时也需说明「没有输出」）；③ 日志需限量。
   */
  const locate = read('src/door/locate.js');
  const view = read('src/panel/view.js');
  check('内核输出：stdout/stderr 均转发到面板日志（可查到原文）',
    /attach\(child\.stdout/.test(locate) && /attach\(child\.stderr/.test(locate) &&
      /内核\[\$\{which\}\]/.test(locate),
    'locate.js 里没看到转发');
  check('内核输出：两路均已接入（stdio 不得将 stdout 设为 ignore）',
    !/stdio: \['ignore', 'ignore', 'pipe'\]/.test(locate) &&
      (locate.match(/stdio: \['ignore', 'pipe', 'pipe'\]/g) || []).length >= 2,
    'Windows 和 POSIX 两条 spawn 路径都要接 stdout');
  check('内核输出：限量（避免插件输出过多写满日志）',
    /OUTPUT_LINE_CAP/.test(locate) && /OUTPUT_CHAR_CAP/.test(locate) &&
      /没记（超过/.test(locate));
  check('内核退出：说明是自行退出 + 退出码',
    /后台 DSH 自己退出了（code=/.test(locate));
  check('内核退出：输出最后几行原文', /它退之前最后说的话/.test(locate));
  check('内核退出：没有任何输出时，明确说明「不是它自己崩的」',
    /一个字都没说就退了/.test(locate));
  check('断线：能区分「自行启动的内核已终止」与「连接的是其他内核」',
    /disconnectText\(/.test(view) && /DSH 自己退出了（code=/.test(view) &&
      /那是别处的 DSH/.test(view));
  check('断线：告知用户查看完整输出的位置', /输出 → DSH Panel/.test(view));

  const logTool = path.join(ROOT, 'tools', 'panel-log.cjs');
  check('有工具可导出面板日志（不必自行查找 VS Code 日志目录）',
    fs.existsSync(logTool) && /DSH Panel\.log/.test(fs.readFileSync(logTool, 'utf8')));
}

{
  /*
   * 内核归属与端口归属（2026-09-19 的结构性修复，见 kernel-manager.js 开头）。
   *
   * 两条规则，均不得回退：
   * ① **视图销毁不等于内核终止**：视图只是使用者，销毁仅释放引用；只有宽限期到期、
   *    窗口关闭、用户显式停止时才真正回收。旧代码在 dispose 中执行 killTree，导致
   *    折叠侧边栏、拖动面板、Reload Window 都变成一次「终止内核并重新连接」。
   * ② **端口由启动内核的一方决定**：面板将 selfStartPort 写入环境变量
   *    DSH_ACP_DOOR_PORT，该插件优先读取该变量；面板自启的内核不再占用桌面端的 47821。
   *    该变量名在扩展与该插件两侧各写一次，必须逐字一致 —— 即由这条断言固定。
   */
  const manager = read('src/panel/kernel-manager.js');
  const viewSource = read('src/panel/view.js');
  const extensionFile = read('src/extension.js');
  const doorPort = read('../dsh-door/lib/port.js');
  const doorIndex = read('../dsh-door/lib/index.js');

  check('内核归属：有专门管理「谁在使用、何时回收」的模块',
    /class KernelManager/.test(manager) && /DEFAULT_IDLE_MS/.test(manager));
  check('内核归属：视图销毁仅释放引用，不终止进程',
    /this\.kernels\.release\(this\)/.test(viewSource) &&
      !/this\.background\.dispose\(\)[\s\S]{0,80}\n  \}/.test(viewSource.slice(viewSource.indexOf('  dispose() {'))),
    'dispose() 里还看得见 background.dispose()');
  check('内核归属：宽限期来自设置（未设置时也有默认值）',
    /kernelIdleMinutes/.test(viewSource) && /setIdleMs\(/.test(manager));
  check('内核归属：窗口关闭时完整回收（deactivate）',
    /function deactivate\(\)[\s\S]{0,400}disposeAll\(/.test(extensionFile));
  check('内核归属：有「停止后台内核」命令（用户可手动确认未残留进程）',
    /dshPanel\.stopKernel/.test(extensionFile) && /dshPanel\.stopKernel/.test(read('package.json')));

  const manifestPorts = JSON.parse(read('package.json')).contributes.configuration.properties;
  check('端口归属：新增 dshPanel.selfStartPort，默认值不是桌面端的 47821',
    Number(manifestPorts['dshPanel.selfStartPort'].default) === 47831,
    String(manifestPorts['dshPanel.selfStartPort'] && manifestPorts['dshPanel.selfStartPort'].default));
  check('端口归属：面板启动内核时将端口写入环境变量',
    /DSH_ACP_DOOR_PORT/.test(read('src/door/locate.js')) && /port: cfg\.selfStartPort/.test(viewSource));
  check('端口归属：该插件也识别该环境变量（两边名称逐字一致）',
    /DSH_ACP_DOOR_PORT/.test(doorPort) && /resolveDoorPort/.test(doorIndex));
  check('端口归属：该插件中的判定顺序为 环境变量 > 档配置 > 默认值',
    /env\.DSH_ACP_DOOR_PORT[\s\S]{0,200}config\.port[\s\S]{0,120}DEFAULT_PORT/.test(doorPort));
  /*
   * 2026-09-20 修改：本条从「固定监听两个端口」改为「监听 fallbackPorts 返回的清单」——
   * 因为新增了一个**仅监听自身端口**的例外（所连内核无法切换权限、改用自行启动的
   * 内核时；同时监听两个端口会把设置中该端口上现成的旧版插件视为「新内核已就绪」，
   * 从而重新连接同一台）。两种清单都必须存在，且默认那份必须仍为两个端口。
   */
  check('端口归属：该插件为旧版（不识别环境变量）时也能连接 —— 默认监听两个端口',
    /fallbackPorts\(cfg\)\s*\{[\s\S]{0,200}return \[cfg\.selfStartPort, cfg\.port\]/.test(viewSource) &&
      /waitForFallbackDoor\([\s\S]{0,220}this\.fallbackPorts\(cfg\)/.test(viewSource));
  check('端口归属：更换内核的路径只监听自身端口（否则会连回同一台）',
    /ownPortOnly[\s\S]{0,120}return \[cfg\.selfStartPort\]/.test(viewSource) &&
      /this\.ownPortOnly = true/.test(viewSource));

  const soak = path.join(ROOT, 'tools', 'soak.cjs');
  check('有长时间运行的耐力测试（用于发现「能启动但存活时间短」这类问题）',
    fs.existsSync(soak) && /turn-every/.test(fs.readFileSync(soak, 'utf8')));
  check('真窗口自检可延长观察时间（DSH_PANEL_CHECK_LINGER）',
    /DSH_PANEL_CHECK_LINGER/.test(read('tools/vscode-check.js')));
}

{
  /*
   * 装机文件中不得包含 UTF-8 BOM（2026-09-19 的事故，已实际发生）。
   *
   * 当时使用 PowerShell 的 `Set-Content -Encoding UTF8` 修改该插件的 package.json，
   * 该命令在文件开头静默写入了 EF BB BF。`npm pack` 将该 BOM 打入 tgz，装入用户档之后
   * 内核加载插件时 `JSON.parse` 直接抛 `SyntaxError: Unexpected token '﻿'` ——
   * 此后 `dsh plugin` 每次执行均崩溃，等同于破坏用户的那一套档。
   * 此类事故必须由一条断言拦截：扩展自身的包、该插件的 package.json 与 lib/ 全部检查。
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
  check(`装机文件中没有 UTF-8 BOM（共检查 ${shippedFiles.length} 个；BOM 会使 JSON.parse 解析失败并影响整个档）`,
    bommed.length === 0, bommed.map((item) => item.relative).join(', '));
}

console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) console.log(`✅ 全部通过：${passed} 项检查`);
else {
  console.log(`❌ 通过 ${passed} 项，失败 ${failed} 项：`);
  for (const item of failures) console.log(`   - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
