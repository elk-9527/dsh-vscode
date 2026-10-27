'use strict';

const COMMANDS = [
  ['new', '新建对话', '当前任务运行时在独立标签页中开始对话'],
  ['review', '审查代码', '选择变更范围并运行代码审查'],
  ['status', '连接状态', '查看连接、模型及当前工作目录'],
  ['model', '切换模型', '从内核公布的模型中选择'],
  ['changes', '本轮改动', '查看差异、保留或撤销单个文件'],
  ['test', '运行测试', '选择工作区配置的测试任务'],
  ['help', '使用帮助', '查看命令、文件和技能引用说明'],
].map(([name, label, description]) => ({ id: `command:${name}`, kind: 'command', label: `/${name} · ${label}`, description, name }));

function commandChoices(query, { busy = false, trusted = true } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return COMMANDS.filter(item => `${item.name} ${item.label} ${item.description}`.toLocaleLowerCase().includes(needle))
    .map(item => ({ ...item, disabled: ['model', 'test', 'changes'].includes(item.name) && busy || ['review', 'test', 'changes'].includes(item.name) && !trusted }));
}
module.exports = { COMMANDS, commandChoices };
