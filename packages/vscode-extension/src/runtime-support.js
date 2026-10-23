'use strict';
/**
 * @param {{ remoteName?: string, uiKind?: number, platform?: string,
 *   workspaceFolders?: readonly {uri: {scheme: string}}[] }} [environment]
 * @returns {{supported: boolean, kind: 'local'|'remote'|'virtual'|'platform', reason?: string}}
 */
function runtimeSupport({ remoteName, uiKind, platform = process.platform, workspaceFolders = [] } = {}) {
  if (remoteName) return { supported: false, kind: 'remote', reason: 'DSH Panel 暂不支持 Remote SSH、WSL 或开发容器窗口。请在本机窗口连接本机 DSH；远程工作区的内核位置和文件读取尚未适配。' };
  if (uiKind === 2 || workspaceFolders.some(folder => folder.uri.scheme !== 'file')) return {
    supported: false, kind: 'virtual', reason: 'DSH Panel 需要桌面版编辑器与本机文件目录，暂不支持浏览器或虚拟工作区。',
  };
  if (!['win32', 'linux', 'darwin'].includes(platform)) return { supported: false, kind: 'platform', reason: '当前平台尚未适配 DSH Panel 的本机内核启动与文件访问。' };
  return { supported: true, kind: 'local' };
}
module.exports = { runtimeSupport };
