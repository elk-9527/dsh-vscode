'use strict';
/** 新内核通过 activation 返回子会话；旧内核直接返回本地 Agent。 */
async function startReviewSubagent(ctx, request) {
  if (typeof ctx.subagents.start === 'function') return ctx.subagents.start('spawn', request);
  if (typeof ctx.subagents.startActivation !== 'function') throw new Error('内核未提供受支持的子 Agent 启动接口');
  const { label, signal, persona, ...input } = request;
  const run = await ctx.subagents.startActivation({ provider: 'spawn', label, request: input, signal, delivery: 'caller' });
  const localAgent = ctx.agents.get(run.childId);
  if (!localAgent) {
    await run.dispose();
    throw new Error('原生审查 Agent 不可用');
  }
  return { ...run, localAgent };
}
/** 原版会话入口继续使用自然语言；Bridge 调用单独选择上游已有的结构化报告规范。 */
function patchReviewRuntime(original) {
  const replacements = [
    ["ctx.subagents.start('spawn', {", 'startReviewSubagent(ctx, {'],
    ['!provider.capabilities.persona', '!(provider.capabilities.persona || provider.capabilities.agentPreset)'],
    ['signal: combined, persona: REVIEW_PROMPT,', 'signal: combined, ...(provider.capabilities.persona ? { persona: REVIEW_PROMPT } : {}),'],
    ['configureReviewer(agent, locale = readHostLocale(agent.ctx))', 'configureReviewer(agent, locale = readHostLocale(agent.ctx), structured = false)'],
    ['text: outputLanguage(locale)', 'text: structured ? `Return only the JSON object required by the review rubric. Write title, body, and overall_explanation in ${locale === "en" ? "English" : "Simplified Chinese"}. Use absolute_file_path and the shortest valid line_range for every finding. Do not add prose or markdown fences.` : outputLanguage(locale)'],
    ['locale = readHostLocale(ctx))', 'locale = readHostLocale(ctx), structured = false, budget)'],
    ['const prompt = await reviewPrompt(target, cwd, combined);', `const prompt = await reviewPrompt(target, cwd, combined);
        const prepared = structured ? await prepareReviewContext(cwd, target, combined) : undefined;
        let inspectionCalls = 0;`],
    ['configureReviewer(agent, locale);', 'configureReviewer(agent, locale, structured);'],
    ['configured = true;', `configured = true;
            if (structured || budget) {
                agent.ctx.tools.guard(exec => { if (isInspectionTool(exec.name)) inspectionCalls++; return budget?.record(); });
                if (budget?.scope) agent.ctx.systemPrompt.context({ name: 'michengai:review-scope', order: 101, text: budget.scope });
            }`],
    ["prompt: [{ type: 'text', text: prompt }],", `prompt: [{ type: 'text', text: prepared?.complete ? prompt + ${JSON.stringify(String.fromCharCode(10, 10))} + prepared.text : prompt }],`],
    ['const report = parseReport(raw);', `if (structured && !hasReviewMaterial(target, prepared, inspectionCalls)) throw new Error('Git 上下文不可用且模型未调用代码检查工具，审查未完成');
        const report = parseReport(raw);`],
  ];
  let result = original;
  for (const [from,to] of replacements) {
    if (result.split(from).length !== 2) throw new Error('审查格式补丁定位失败');
    result = result.replace(from,to);
  }
  return `import contextRuntime from './review-context.cjs';\nconst { prepareReviewContext, hasReviewMaterial, isInspectionTool } = contextRuntime;\n${startReviewSubagent.toString()}\n${result}`;
}
module.exports = { patchReviewRuntime, startReviewSubagent };
