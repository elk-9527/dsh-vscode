'use strict';
const EXPECTED = [
  { id: 'michengai.code-review.run', title: '审查代码变更', package: '@michengai/dsh-code-review', provider: { id: 'michengai.code-review', name: '代码审查' } },
  { id: 'linxin.skill-explorer.list', title: '浏览技能', package: '@linxin666/dsh-client-ui-skill-explorer', provider: { id: 'linxin.skill-explorer', name: '技能浏览' } },
  { id: 'linxin.skill-explorer.health', title: '检查技能状态', package: '@linxin666/dsh-client-ui-skill-explorer', provider: { id: 'linxin.skill-explorer', name: '技能浏览' } },
];
/** 目录缺失不能证明未安装；安装状态仅用于已确认的当前配置集。 */
function capabilityState({ capability, connected, supported, trusted = true, installed, profileKnown = false, authorized = true }) {
  const result = (state, detail, action, command) => ({ state, detail, action, command, executable: state === 'available' });
  if (!connected) return result('disconnected', '尚未连接 DSH', '重新连接', 'dshPanel.bridge.refresh');
  if (!supported) return result('unsupported', '当前接入点版本不支持插件能力', '查看版本与更新说明', 'dshPanel.bridge.diagnoseConfig');
  if (!authorized) return result('unauthorized', '当前连接尚未通过身份验证', '重新连接', 'dshPanel.reconnect');
  if (!trusted && (capability?.id === 'michengai.code-review.run' || ['execute', 'workspace-write', 'system'].includes(capability?.riskTier))) return result('restricted', '此操作需要受信任的工作区', '查看工作区信任', 'workbench.trust.manage');
  if (!capability || capability.missing) {
    if (profileKnown && installed === false) return result('missing', '当前配置集缺少对应插件', '查看安装说明', 'dshPanel.bridge.installGuide');
    if (profileKnown && installed === true) return result('unregistered', '插件已安装，当前内核尚未提供此能力', '查看加载与注册诊断', 'dshPanel.bridge.diagnoseConfig');
    return result('unknown', '当前内核没有提供此能力；安装与加载状态尚未确认', '查看配置诊断', 'dshPanel.bridge.diagnoseConfig');
  }
  if (capability.availability?.state === 'available') return result('available', '可用', '', undefined);
  const reason = capability.availability?.reason;
  // 提供方原因不直接显示，避免将内部错误或凭据带入界面。
  if (reason === 'version-incompatible') return result('incompatible', '插件版本不兼容', '查看版本与来源', 'dshPanel.bridge.installGuide');
  if (reason === 'permission-denied' || reason === 'workspace-untrusted') return result('restricted', '当前权限不允许此操作', '查看权限说明', 'dshPanel.bridge.diagnoseConfig');
  return result('unavailable', '插件当前未开放此操作', '查看配置诊断', 'dshPanel.bridge.diagnoseConfig');
}
module.exports = { EXPECTED, capabilityState };
