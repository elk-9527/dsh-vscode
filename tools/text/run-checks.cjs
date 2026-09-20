/*
 * 中文表述规范化的门禁汇总入口（已纳入版本控制：tools/text/）。
 *
 * 用途：依次运行全部质量门禁，输出一张汇总表，任一项未通过时以非零码结束。
 *       单项脚本的判定口径见 docs/注释与文档规范.md 第 9 节。
 *
 * 说明：text-check.cjs 的输出恒记为「提示」。该脚本列出的是待人工判断的命中项
 *       （可能是引文、夹具、正则或路径字面值），其本身不构成通过或未通过。
 *
 * 用法：node tools/text/run-checks.cjs [--base=<提交>]
 *       基线默认为 HEAD（提交前比较工作区）。提交之后用 --base=<基线提交> 复现同一批证据。
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length) : 'HEAD';
const basePass = baseArg ? [`--base=${BASE}`] : [];

/**
 * 门禁清单。每项的 judge 接收脚本输出与退出码，返回 'pass' | 'fail' | 'info' 与备注。
 * @type {{name: string, script: string, args: string[], judge: (out: string, code: number) => {verdict: string, note: string}}[]}
 */
const CHECKS = [
  {
    name: '文本命中（注释）',
    script: 'tools/text/text-check.cjs',
    args: [],
    judge: (out) => ({ verdict: 'info', note: (/(合计 \d+ 处命中[^\n]*)/.exec(out) || ['', '无输出'])[1] }),
  },
  {
    name: '文本命中（字符串）',
    script: 'tools/text/text-check.cjs',
    args: ['--strings'],
    judge: (out) => ({ verdict: 'info', note: (/(合计 \d+ 处命中[^\n]*)/.exec(out) || ['', '无输出'])[1] }),
  },
  {
    name: '代码骨架越界',
    script: 'tools/text/code-diff-check.cjs',
    args: basePass,
    judge: (out, code) => ({
      verdict: code === 0 ? 'pass' : 'fail',
      note: (/(代码行被改动的文件：\d+ 个[^\n]*)/.exec(out) || ['', '无输出'])[1],
    }),
  },
  {
    name: '注释体量',
    script: 'tools/text/comment-volume.cjs',
    args: basePass,
    judge: (out) => ({
      // 成功分支输出「未见成段删除的迹象」，失败分支输出「降幅超过 N% 的文件」。
      verdict: out.includes('未见成段删除的迹象') ? 'pass' : 'fail',
      note: (/(合计：\d+ → \d+[^\n]*)/.exec(out) || ['', '无输出'])[1],
    }),
  },
  {
    name: '覆盖面',
    script: 'tools/text/coverage-audit.cjs',
    args: basePass,
    judge: (out) => ({
      verdict: /其中未被触及：0 个；无法读取：0 个/.test(out) ? 'pass' : 'fail',
      note: (/(含中文的已跟踪文件：\d+ 个[^\n]*)/.exec(out) || ['', '无输出'])[1],
    }),
  },
  {
    name: '跨包报文一致性',
    script: 'tools/text/forward-compat-check.cjs',
    args: [],
    judge: (out, code) => ({ verdict: code === 0 ? 'pass' : 'fail', note: code === 0 ? '新旧报文分类一致' : '分类不一致，详见输出' }),
  },
  {
    name: '行尾与 BOM',
    script: 'packages/vscode-extension/tools/check-eol.cjs',
    args: [],
    judge: (out, code) => ({
      verdict: code === 0 ? 'pass' : 'fail',
      note: (/(混着两种：\d+)[^\n]*/.exec(out) || ['', '无输出'])[1],
    }),
  },
];

const results = [];
for (const check of CHECKS) {
  let out = '';
  let code = 0;
  try {
    // stderr 单独捕获：git 在各脚本内会输出行尾转换告警，属既有环境噪声，不进入汇总表。
    out = execFileSync(process.execPath, [path.join(ROOT, check.script), ...check.args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
    out = `${error.stdout || ''}${error.stderr || ''}`;
  }
  const judged = check.judge(out, code);
  results.push({ ...check, ...judged, out });
  const mark = judged.verdict === 'pass' ? '✅' : judged.verdict === 'fail' ? '❌' : '·';
  console.log(`${mark} ${check.name.padEnd(14, '　')} ${judged.note}`);
}

const failed = results.filter((r) => r.verdict === 'fail');
console.log(`\n基线 ${BASE}：通过 ${results.filter((r) => r.verdict === 'pass').length} 项，未通过 ${failed.length} 项，提示 ${results.filter((r) => r.verdict === 'info').length} 项`);
if (failed.length > 0) {
  console.log('\n未通过项的完整输出：');
  for (const item of failed) console.log(`\n───── ${item.name} ─────\n${item.out}`);
}
process.exit(failed.length === 0 ? 0 : 1);
