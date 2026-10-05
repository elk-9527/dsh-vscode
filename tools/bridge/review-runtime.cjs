'use strict';
/** 原版会话入口继续使用自然语言；Bridge 调用单独选择上游已有的结构化报告规范。 */
function patchReviewRuntime(original) {
  const replacements = [
    ['configureReviewer(agent, locale = readHostLocale(agent.ctx))', 'configureReviewer(agent, locale = readHostLocale(agent.ctx), structured = false)'],
    ['text: outputLanguage(locale)', 'text: structured ? `Return only the JSON object required by the review rubric. Write title, body, and overall_explanation in ${locale === "en" ? "English" : "Simplified Chinese"}. Use absolute_file_path and the shortest valid line_range for every finding. Do not add prose or markdown fences.` : outputLanguage(locale)'],
    ['locale = readHostLocale(ctx))', 'locale = readHostLocale(ctx), structured = false)'],
    ['configureReviewer(agent, locale);', 'configureReviewer(agent, locale, structured);'],
  ];
  let result = original;
  for (const [from,to] of replacements) {
    if (result.split(from).length !== 2) throw new Error('审查格式补丁定位失败');
    result = result.replace(from,to);
  }
  return result;
}
module.exports = { patchReviewRuntime };
