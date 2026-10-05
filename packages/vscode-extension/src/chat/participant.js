'use strict';
const { reportText } = require('../bridge/results');
const path = require('node:path');
const PARTICIPANT = 'dshPanel.dsh';

/** 原生 Chat 使用同一 DSH 配置和公开 API；旧编辑器继续使用面板。 */
function registerChat({ vscode, context, api, panel, log = () => {} }) {
  if (typeof vscode.chat?.createChatParticipant !== 'function') { log('info', '当前编辑器未提供原生 Chat API，继续使用 DSH 面板'); return undefined; }
  const sessions = new Map();
  const identity = cwd => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
  const cwdFor = async request => {
    const referenced = request.references?.map(item => item.value?.uri || item.value).find(value => value?.scheme === 'file');
    const folder = referenced && vscode.workspace.getWorkspaceFolder(referenced);
    if (folder) return folder.uri.fsPath;
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) return folders[0].uri.fsPath;
    const selected = await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, cwd: item.uri.fsPath })), { placeHolder: '选择 DSH 对话工作区' });
    return selected?.cwd;
  };
  const handler = async (request, chatContext, stream, token) => {
    const abort = new AbortController(), cancel = token.onCancellationRequested(() => abort.abort());
    if (token.isCancellationRequested) abort.abort();
    let handle;
    try {
      const cwd = await cwdFor(request); if (!cwd || abort.signal.aborted) return {};
      const previous = [...(chatContext.history || [])].reverse().map(turn => turn.result?.metadata?.dsh).find(value => typeof value?.cwd === 'string' && identity(value.cwd) === identity(cwd));
      if (request.command === 'open-panel') {
        if (previous) { handle = await api.restoreSession({ ...previous, userInitiated: true }); await api.openPanel(handle); }
        else await vscode.commands.executeCommand('dshPanel.open');
        stream.markdown('已打开 DSH 面板。'); return handle ? { metadata: { dsh: handle } } : {};
      }
      if (request.command === 'new') {
        if (previous) await api.closeSession(sessions.get(previous.sessionId) || await api.restoreSession({ ...previous, userInitiated: true }));
        if (previous) sessions.delete(previous.sessionId);
        handle = await api.createSession({ cwd, userInitiated: true });
        sessions.set(handle.sessionId, handle); stream.markdown('已开始新的 DSH 对话。');
        return { metadata: { dsh: handle } };
      }
      if (request.command === 'skills') {
        const result = await api.invokeCapability({ cwd, capabilityId: 'linxin.skill-explorer.list', input: {} });
        const groups = result.value?.groups || [];
        stream.markdown(groups.length ? groups.map(group => `### ${group.title}\n\n${group.skills.map(skill => `- ${skill.name}${skill.description ? '：' + skill.description : ''}`).join('\n')}`).join('\n\n') : '当前没有可浏览的技能。');
        stream.button({ command: 'dshPanel.bridge.skills', title: '浏览技能正文' }); return {};
      }
      if (request.command === 'review') {
        stream.progress('正在审查当前工作区变更…');
        const result = await api.review({ cwd, input: request.prompt.trim() ? { mode: 'custom', instructions: request.prompt } : { mode: 'worktree' }, userInitiated: true, signal: abort.signal });
        stream.markdown(result?.result ? reportText(result.result, result.stale) : '审查已结束，可在运行记录中查看结果。');
        return {};
      }
      if (previous) {
        handle = await api.restoreSession({ cwd, sessionId: previous.sessionId, preset: previous.preset, userInitiated: true });
      } else handle = await api.createSession({ cwd, userInitiated: true });
      sessions.set(handle.sessionId, handle);
      stream.progress('正在连接 DSH…');
      const result = await api.prompt(handle, request.prompt, { userInitiated: true, signal: abort.signal,
        onEvent: event => { if (event.type === 'text') stream.markdown(event.delta); if (event.type === 'tool') stream.progress(event.tool?.title || '正在执行工具…'); },
        onPermission: async params => (await vscode.window.showQuickPick(params.options.map(option => ({ label: option.name, optionId: option.optionId })), { placeHolder: params.toolCall?.title || 'DSH 请求执行工具', ignoreFocusOut: true }, token))?.optionId,
      });
      stream.button({ command: 'dshPanel.chat.openSession', title: '在 DSH 面板继续', arguments: [handle] });
      return { metadata: { dsh: result.session } };
    } catch (error) {
      if (error.code !== -32800 && !abort.signal.aborted) stream.markdown(error.message);
      return handle ? { metadata: { dsh: handle } } : {};
    } finally { cancel.dispose(); }
  };
  let participant;
  try { participant = vscode.chat.createChatParticipant(PARTICIPANT, handler); }
  catch (error) { log('warn', '原生 Chat 当前不可用：' + error.message); return undefined; }
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dsh.svg');
  context.subscriptions.push(participant, vscode.commands.registerCommand('dshPanel.chat.openSession', async handle => api.openPanel(await api.restoreSession({ ...handle, userInitiated: true }))));
  return { participant, handler };
}
module.exports = { registerChat, PARTICIPANT };
