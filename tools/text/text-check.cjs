/*
 * 中文文本合规扫描器（质量门禁工具，已纳入版本控制：tools/text/）。
 *
 * 用途：按 docs/注释与文档规范.md 检查仓库内的中文文本，列出可能违反规范的文本行。
 * 该工具只做提示，不能替代人工判断：命中项需逐条确认是「确实违规」还是「引文/专名/算子」。
 *
 * 两种口径：
 *   node tools/text/text-check.cjs [路径 ...]             默认只扫描注释行
 *   node tools/text/text-check.cjs --strings [路径 ...]   只扫描代码行（字符串字面量所在行）
 *
 * 两种口径的规则集合不同，原因：
 *   - 注释是连续的说明文字，第一/第二人称与问句、感叹号都是文风问题，因此全部规则适用。
 *   - 代码行里的中文大量来自「发给模型的提示原文」与「实验夹具」，其中的「你/我」与问句是
 *     实验输入的一部分，改掉就等于改变实验；代码行的问号与感叹号则多为 `?.`、`??`、`!x`
 *     这类算子。因此字符串口径只保留「术语、比喻拟人、口语、兜底」这几类规则。
 *
 * 标点口径：只把全角 `？`、`！` 视为问句与感叹（中文正文里正文使用全角；半角 `?`/`!`
 * 在代码里几乎总是算子或 `!important`）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** 不参与扫描的路径片段。 */
const SKIP = [
  'node_modules', `${path.sep}build`, `${path.sep}backup`, `${path.sep}.git`,
  `${path.sep}shots`, 'spike\\capture', 'spike\\scratch', `${path.sep}dist`,
  // 扫描器自身的词表含有它要检测的样例词（例如黑名单正则），扫描自身只会产生固定噪声。
  path.join('tools', 'text'),
];

/**
 * 全文豁免的文件。
 * `docs/注释与文档规范.md` 必须引用这些词才能说明改写方向，属于规范本身的必需内容。
 */
const SKIP_FILES = [path.join('docs', '注释与文档规范.md')];

/**
 * 逐行豁免：已人工复核、确认属于引文或专名，不计入命中。
 * 键为 `相对路径:行号`（路径统一用正斜杠），值为豁免理由。行号变化时需要同步更新。
 * 目前为空：所有引文位置都已按实际情况确认，无需豁免。
 */
const REVIEWED = new Map();

/** 参与扫描的扩展名。 */
const EXT = new Set(['.js', '.cjs', '.mjs', '.md', '.css', '.html', '.yml', '.yaml', '.json']);

/** 全部检查项：名称 + 正则 + 说明 + 是否适用于字符串口径。 */
const RULES = [
  // 「专门」「部门」「自报家门」等普通词与成语含有「门」字，不算术语违规；只有独立指代该插件时才命中。
  ['术语-门', /(?<![专部家])门/, '正文不得单独使用该简称，应写「ACP 接入点插件（dsh-acp-door）」', true],
  ['人称', /你|我/, '不得使用第一、第二人称', false],
  // 「分」之后的「别」属于「分别」「别处」等正常用词，用否定回顾排除，避免误报。
  // 「露出/关掉/藏着/拿掉」等动词是口语用法，正式表述为「显示/关闭/隐藏/移除」。
  ['口语', /(?<!分)别(?=[改忘把让用拿写说动急怕])|不用|就得|其实|反正|嘛|吧|呢|啦|哦|啰嗦|咋|啥|搞定|搞|弄|露出|关掉|藏着|拿掉|没法|照样/, '口语化表达', true],
  ['语气', /[！]/, '不得使用感叹号', false],
  ['疑问', /[？]/, '不得使用问句', false],
  ['比喻夸张', /撑爆|掐掉|撞车|吃掉|喂给|裸写|一眼|顺手|白试|瞎猜|凭空|原地打转|一塌糊涂|离谱|要命|压根|硬生生|背锅|甩锅|神器|银弹|踩坑|踩过|闸门|炸掉|会炸/, '比喻或夸张表达', true],
  // 「不认识」单独使用属于正常技术表述（「无法识别」的等价说法），因此只在该词与「门」连用时判定为拟人。
  ['拟人', /门太旧|门不认识|活着|死掉|杀掉|自己会/, '拟人化表达', true],
  ['兜底', /兜底/, '口语化的技术表述，可改为「回退」「后备」或具体行为', true],
  ['口语扩展', /塞进|塞到|塞给|冒出来|蹦出来|一上来|扭头|甩给|一堆|一坨|完蛋|崩了|炸了|挂了|歇了|翻倍|好几倍|好几个/, '口语化或夸张表达', true],
  ['口语终验', /干等|钉死|焊|裸|白跑|跑偏|折腾|玩意儿|收摊|张罗|冒烟|硬扛|顶不住|撑不住|兜住|一刀切|半死不活|擦屁股|咱|您/, '口语化表达（终验词表）', true],
];

/** 判断一行是否是注释行（按行首特征，不解析语法）。 */
function isCommentLine(ext, line) {
  const t = line.trim();
  if (ext === '.md' || ext === '.yml' || ext === '.yaml') return true;
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')) return true;
  if (t.startsWith('#')) return true;
  if (t.startsWith('<!--')) return true;
  return false;
}

/**
 * 命令行开关 `--strings`：改为只扫描代码里的字符串字面量行（非注释行）。
 * 用于单独评估日志、提示语等字符串中的中文，与注释分开统计。
 */
const STRING_MODE = process.argv.includes('--strings');

function walk(target, out) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SKIP_FILES.some((name) => target.endsWith(name))) return;
    if (EXT.has(path.extname(target).toLowerCase())) out.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (SKIP.some((part) => full.includes(part))) continue;
    if (SKIP_FILES.some((name) => full.endsWith(name))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

const pathArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const targets = pathArgs.length > 0 ? pathArgs : [ROOT];
const files = [];
for (const t of targets) walk(path.resolve(ROOT, t), files);

let hits = 0;
const perFile = new Map();
const reviewed = [];
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    // 默认只扫描注释行；--strings 模式改为只扫描代码行（字符串字面量所在的那些行）。
    const isComment = isCommentLine(ext, line);
    if (STRING_MODE ? isComment : !isComment) return;
    if (!/[\u4e00-\u9fff]/.test(line)) return;
    // 键统一用正斜杠：`path.relative` 在 Windows 上产出反斜杠，会导致豁免键匹配不到。
    const key = `${rel.replace(/\\/g, '/')}:${index + 1}`;
    if (REVIEWED.has(key)) {
      reviewed.push(`${key}  （${REVIEWED.get(key)}）`);
      return;
    }
    for (const [name, re, why, inStrings] of RULES) {
      if (STRING_MODE && !inStrings) continue;
      if (re.test(line)) {
        hits += 1;
        perFile.set(file, (perFile.get(file) || 0) + 1);
        // 单行输出：便于整体阅读，也避免长输出被截断后命中项与文本错位。
        console.log(`${rel}:${index + 1}  [${name}]  ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

console.log(`\n合计 ${hits} 处命中，涉及 ${perFile.size} 个文件`);
if (reviewed.length > 0) {
  console.log('\n已人工复核豁免（引文或专名，不计入命中）：');
  for (const item of reviewed) console.log(`  ${item}`);
}
if (perFile.size > 0) {
  console.log('\n按文件汇总：');
  for (const [file, count] of [...perFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${path.relative(ROOT, file)}`);
  }
}
