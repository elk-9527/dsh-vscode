'use strict';
/** 诊断只展示内核公布的选择标签，不读取服务商密钥或原始配置。 */
function modelDiagnostics(options = []) {
  const lines = ['## 会话模型配置'];
  for (const id of ['model', 'reasoning_effort']) {
    const option = options.find(item => id === 'model' ? item?.id === id : item && (item.category === 'thought_level' || /reasoning|thinking|thought/i.test(item.id)) && Array.isArray(item.options));
    const label = id === 'model' ? '模型' : '思考强度';
    if (!option) { lines.push(`${label}：内核未公布该配置项。`); continue; }
    const choices = (option.options || []).flatMap(item => item?.options || [item]);
    const name = choice => String(choice?.name || '未命名').replace(/[\r\n\0`<>\[\]|]/g, '').slice(0, 128);
    const current = choices.find(choice => choice?.value === option.currentValue);
    lines.push(`${label}：${current ? name(current) : '当前值不在可选清单中，请重新选择'}。`);
    if (id === 'reasoning_effort') lines.push(`可选思考强度：${choices.map(name).join('、') || '暂无'}。`);
  }
  lines.push('选择只作用于当前会话；回合结束后可以调整。不支持的思考强度需重新选择后重试。');
  return lines.join('\n\n');
}
module.exports = { modelDiagnostics };
