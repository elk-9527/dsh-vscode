'use strict';

/**
 * 界面设计基线审计：测量当前 CSS 中手工设定的各项数值。
 *
 * 设置该脚本的原因：界面美化需要等待样稿，而当前实际使用了几个间距值、
 * 几种字号、几个圆角属于客观数据，可以先行测量；样稿确定后即可据此确定需要修改的位置，
 * 修改后重新运行一次即可证明数值已收敛到新基线，无需凭主观判断说明界面更为整齐。
 *
 * 判据（属于工程约束，不属于审美判断）：
 *   - 间距（padding/margin/gap）应当落在同一个尺度上，不得混用 3/5/7/9/11px；
 *   - 字号种类应当少而有序（层级由字号与字重体现，不采用「多一种字号即多一档」的做法）；
 *   - 圆角应当只有少数几档（按层级划分，不按元素划分）；
 *   - 颜色一律使用 VS Code 主题变量（硬性约束：跟随主题）。
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
  // 移除注释，避免注释中的示例被计入统计。
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([a-z-]+)\s*:\s*([^;{}]+);/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    list.push({ property: match[1].trim(), value: match[2].trim() });
  }
  return list;
}

/** 将 "8px 12px" 这类取值展开为单个长度值。 */
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
  // 基线：2px 刻度（2/4/8/12/16）。不检查 4px 的原因：下拉框与小块这类
  // 紧凑元素合法地使用 2px，若以 4px 为判据会将其误报为不符合尺度。
  const offScale = spacingValues.filter((value) => value % 2 !== 0);
  console.log(`  不在 2px 刻度上的：${offScale.length ? offScale.map((v) => `${v}px`).join(' / ') : '没有'}`);

  const fontSizes = [...fontSize.keys()].sort();
  console.log(`\n字号（${fontSizes.length} 种）：${fontSizes.join(' / ')}`);

  const radiusValues = sorted(radius);
  console.log(`\n圆角（${radiusValues.length} 种）：${radiusValues.map((v) => `${v}px`).join(' / ')}`);

  const lineHeights = [...lineHeight.keys()].sort();
  console.log(`行高（${lineHeights.length} 种）：${lineHeights.join(' / ')}`);

  console.log(`\n主题变量用了 ${themeVars.size} 个：${[...themeVars].sort().slice(0, 8).join(', ')}${themeVars.size > 8 ? ' …' : ''}`);
  console.log(`硬编码颜色：${hardcodedColors.length ? hardcodedColors.join(' / ') : '没有（全部走主题变量）'}`);

  // 报告仅使用过一次的间距值：此类数值通常为临时加入的取值。
  const singletons = spacingValues.filter((value) => spacing.get(value).length === 1);
  console.log(`\n只用了一次的间距值：${singletons.length ? singletons.map((v) => `${v}px`).join(' / ') : '没有'}`);

  if (process.argv.includes('--strict') && hardcodedColors.length) {
    console.log('\n❌ 有硬编码颜色（应当一律走主题变量）');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { declarations, lengths };
