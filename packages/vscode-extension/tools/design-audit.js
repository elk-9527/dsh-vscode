'use strict';

/**
 * 界面设计基线审计：把现在这套 CSS 里「手工凑出来的数」量出来。
 *
 * 为什么要有这个：美化这一步要等你的样稿，但"现在到底用了几个间距值、
 * 几种字号、几个圆角"是客观数据，先量出来 —— 样稿一到就知道要改哪些地方，
 * 改完再跑一次还能证明"确实收敛到了新基线"，而不是凭感觉说"更整齐了"。
 *
 * 判据（不是审美，是纪律）：
 *   - 间距（padding/margin/gap）应当落在一个尺度上，而不是 3/5/7/9/11px 混用；
 *   - 字号种类应当少而有序（层级靠字号+字重，不靠"多一种就多一档"）；
 *   - 圆角应当只有少数几档（按层级，不按元素）；
 *   - 颜色一律走 VS Code 主题变量（这是硬规矩：跟随主题）。
 *
 * 用法：node tools/design-audit.js          # 打印报告
 *      node tools/design-audit.js --strict  # 发现硬编码颜色就退出码非 0
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS = path.join(ROOT, 'media', 'main.css');

const SPACING = /^(padding|margin|gap|row-gap|column-gap|padding-(top|right|bottom|left)|margin-(top|right|bottom|left))$/;
const RADIUS = /^border(-(top|bottom)-(left|right))?-radius$/;

function declarations(text) {
  const list = [];
  // 去掉注释，免得注释里的示例被算进统计。
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([a-z-]+)\s*:\s*([^;{}]+);/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    list.push({ property: match[1].trim(), value: match[2].trim() });
  }
  return list;
}

/** 把 "8px 12px" 这类展开成一个个长度值。 */
function lengths(value) {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const px = /^(-?\d+(?:\.\d+)?)px$/.exec(part);
      if (px) return Number(px[1]);
      return null; // 变量、0、calc() 之类，不参与尺度统计
    })
    .filter((item) => item !== null && item !== 0);
}

function tally(map, key, where) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(where);
}

function main() {
  const css = fs.readFileSync(CSS, 'utf8');
  const list = declarations(css);

  const spacing = new Map();
  const fontSize = new Map();
  const radius = new Map();
  const hardcodedColors = [];
  const themeVars = new Set();
  const lineHeight = new Map();

  for (const item of list) {
    if (SPACING.test(item.property)) {
      for (const value of lengths(item.value)) tally(spacing, value, item.property);
    } else if (item.property === 'font-size') {
      tally(fontSize, item.value, item.property);
    } else if (RADIUS.test(item.property)) {
      for (const value of lengths(item.value)) tally(radius, value, item.property);
    } else if (item.property === 'line-height') {
      tally(lineHeight, item.value, item.property);
    }
    if (/color$/i.test(item.property) || item.property === 'background' || item.property === 'border') {
      const vars = item.value.match(/var\(--vscode-[a-z-]+/g) || [];
      vars.forEach((name) => themeVars.add(name.replace('var(', '')));
      const hex = item.value.match(/#[0-9a-fA-F]{3,8}\b/g);
      const rgb = item.value.match(/\brgba?\([^)]*\)/g);
      if (hex || rgb) {
        hardcodedColors.push(`${item.property}: ${item.value}`);
      }
    }
  }

  const sorted = (map) => [...map.keys()].sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));

  console.log('界面设计基线审计');
  console.log(`  看了 ${path.relative(ROOT, CSS)}：${list.length} 条声明\n`);

  const spacingValues = sorted(spacing);
  console.log(`间距值（${spacingValues.length} 种）：${spacingValues.map((v) => `${v}px`).join(' / ')}`);
  const offScale = spacingValues.filter((value) => value % 4 !== 0);
  console.log(`  不在 4px 尺度上的：${offScale.length ? offScale.map((v) => `${v}px`).join(' / ') : '没有'}`);

  const fontSizes = [...fontSize.keys()].sort();
  console.log(`\n字号（${fontSizes.length} 种）：${fontSizes.join(' / ')}`);

  const radiusValues = sorted(radius);
  console.log(`\n圆角（${radiusValues.length} 种）：${radiusValues.map((v) => `${v}px`).join(' / ')}`);

  const lineHeights = [...lineHeight.keys()].sort();
  console.log(`行高（${lineHeights.length} 种）：${lineHeights.join(' / ')}`);

  console.log(`\n主题变量用了 ${themeVars.size} 个：${[...themeVars].sort().slice(0, 8).join(', ')}${themeVars.size > 8 ? ' …' : ''}`);
  console.log(`硬编码颜色：${hardcodedColors.length ? hardcodedColors.join(' / ') : '没有（全部走主题变量）'}`);

  // 报告那些"只用了一次的间距值" —— 这类值最像随手写的。
  const singletons = spacingValues.filter((value) => spacing.get(value).length === 1);
  console.log(`\n只用了一次的间距值：${singletons.length ? singletons.map((v) => `${v}px`).join(' / ') : '没有'}`);

  if (process.argv.includes('--strict') && hardcodedColors.length) {
    console.log('\n❌ 有硬编码颜色（应当一律走主题变量）');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { declarations, lengths };
