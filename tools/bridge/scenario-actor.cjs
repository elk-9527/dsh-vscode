'use strict';
/** 在隔离的实际编辑器宿主中按使用顺序执行；选择框仅替换选择动作，不替换服务结果。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario-config.json'), 'utf8'));
const wait = async (predicate, timeout = 180000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('场景等待超时');
};
const write = (name, value) => {
  const file = path.join(config.folder, name), temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  // The polling reader can briefly hold a Windows handle without delete sharing.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 49) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
};
const read = name => JSON.parse(fs.readFileSync(path.join(config.folder, name), 'utf8'));
exports.activate = async () => {
  const phase = fs.existsSync(path.join(config.folder, 'cleanup-checkpoint.json')) ? 'final-reopen'
    : fs.existsSync(path.join(config.folder, 'running-checkpoint.json')) ? 'resume' : 'initial';
  const checks = phase === 'initial' ? [] : read('progress.json').checks;
  const phaseStarted = Date.now(); let activeStep;
  const startStep = name => { activeStep = name; write('progress.json', { phase, checks, activeStep, elapsedMs: Date.now() - phaseStarted }); };
  const check = (name, evidence = {}) => { activeStep = undefined; checks.push({ name, status: 'passed', phase, elapsedMs: Date.now() - phaseStarted, evidence }); write('progress.json', { phase, checks, elapsedMs: Date.now() - phaseStarted }); };
  let native, panel, timer;
  const restored = [];
  const run = async () => {
    const extension = vscode.extensions.getExtension('Elk-ydy.dsh-acp-panel'); assert(extension);
    const root = extension.extensionPath;
    const api = await extension.activate();
    const observed = process[Symbol.for('dsh.scenario.observer')]; assert(observed, '隔离观察接口未加载');
    const panelApi = observed.vscode; native = observed.nativeViews; panel = observed.view;
    const picks = [], errors = [], invocations = [];
    const inputBoxes = [], confirmations = [];
    const quickPick = panelApi.window.showQuickPick, showError = panelApi.window.showErrorMessage;
    panelApi.window.showQuickPick = async (items, options) => {
      const choice = picks.shift(); assert(choice, `未预设选择动作：${options?.placeHolder}`);
      assert.equal(options?.placeHolder, choice.prompt); if (choice.cancel) return undefined;
      const selected = (await items).find(choice.match); assert(selected, '实际选择框中没有目标选项'); return selected;
    };
    panelApi.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
    restored.push(() => { panelApi.window.showQuickPick = quickPick; panelApi.window.showErrorMessage = showError; });
    const inputBox = panelApi.window.showInputBox, information = panelApi.window.showInformationMessage;
    panelApi.window.showInputBox = async options => { const choice = inputBoxes.shift(); assert(choice && options.prompt === choice.prompt); return choice.value; };
    panelApi.window.showInformationMessage = async (message, ...options) => { if (options.includes('确认应用') || options.includes('应用此项')) { const choice = confirmations.shift(); assert(choice); return choice === 'cancel' ? undefined : choice; } return undefined; };
    restored.push(() => { panelApi.window.showInputBox = inputBox; panelApi.window.showInformationMessage = information; });
    const startupNotices=[],startupPost=panel.post;
    panel.post=function(message){if(['error','notice'].includes(message.type)){startupNotices.push(message);write('startup-notices.json',startupNotices);}return startupPost.call(this,message);};
    restored.push(()=>{panel.post=startupPost;});
    await vscode.commands.executeCommand('dshPanel.open');
    await wait(() => panel.session?.sessionId, 75000);
    const catalog = await api.listCapabilities(); assert.equal(catalog.capabilities.length, 7);
    const bridgePrototype = Object.getPrototypeOf(native.connections.bridge);
    const request = bridgePrototype.request;
    bridgePrototype.request = async function (method, params, options) {
      if (method === 'invoke') invocations.push({ id: params.capabilityId, mode: params.input?.mode });
      return request.call(this, method, params, options);
    };
    restored.push(() => { bridgePrototype.request = request; });
    const connection = native.connections.snapshot(); assert(connection.authorized); assert.equal(connection.port, config.port);
    const endpoint = JSON.parse(fs.readFileSync(path.join(config.home, `run/dsh-acp-door/${config.port}.json`), 'utf8'));
    write('test-kernel.json', { pid: endpoint.pid, port: endpoint.port, instanceId: connection.instanceId });
    const file = vscode.Uri.file(config.sample), reviewCount = () => invocations.filter(x => x.id === 'michengai.code-review.run').length;
    const diagnostics = () => vscode.languages.getDiagnostics(file).filter(x => x.source === 'DSH');
    const reportFor = id => vscode.workspace.textDocuments.find(x => x.uri.path === `/review/${id}.md`);
    const clean = async () => vscode.commands.executeCommand('dshPanel.bridge.clearFinished');
    if (phase === 'final-reopen') {
      assert.equal(native.operations.size, 0); assert.equal(diagnostics().length, 0);
      assert.equal(reviewCount(), 0);
      check('清理后再次重开没有恢复已删除记录', { records: 0, Problems: 0, automaticReviewInvocations: 0 });
      write('editor-result.json', { status: 'passed', checks, editor: vscode.version });
      await vscode.commands.executeCommand('workbench.action.closeWindow'); return;
    }
    if (phase === 'resume') {
      const previous = read('running-checkpoint.json');
      assert.equal(connection.instanceId, previous.instanceId); assert.equal(native.connections.clientId, previous.clientId);
      check('审查中重开复用原内核及客户端身份', { sameInstance: true, sameClient: true });
      const op = await wait(() => { const found = native.operations.get(previous.id); return found && ['completed', 'failed', 'unrecoverable'].includes(found.status) && found; });
      assert.equal(op.status, 'completed', op.reason); assert.equal(reviewCount(), 0);
      await vscode.commands.executeCommand('dshPanel.bridge.openReport', op.id);
      assert(reportFor(op.id)?.getText().length); assert(diagnostics().length);
      check('原运行完成并恢复报告与问题定位', { sameOperation: op.id === previous.id, findings: diagnostics().length, automaticReviewInvocations: 0 });
      assert.equal(native.operations.size, 1);
      await vscode.window.showTextDocument(reportFor(op.id), { preview: false });
      const removed = await clean(); assert.equal(removed, 1); await wait(() => diagnostics().length === 0, 5000); assert(reportFor(op.id)?.getText().length);
      check('恢复后清理保留已打开报告', { removed, openReportKept: true });
      write('cleanup-checkpoint.json', { id: op.id });
      await vscode.commands.executeCommand('workbench.action.closeWindow'); return;
    }
    check('冷启动打开单个 DSH 入口并连接', { version: extension.packageJSON.version, editor: vscode.version, selfStarted: connection.profile === 'scenario', capabilities: catalog.capabilities.length });
    const capabilities = await native.capabilityChildren();
    assert(capabilities.some(x => x.id === 'michengai.code-review.run' && x.contextValue === 'dshAvailableCapability'));
    assert.deepEqual(capabilities.map(item => item.label), ['审查代码', '浏览技能']);
    assert(capabilities.every(item => item.collapsibleState === vscode.TreeItemCollapsibleState.None && item.command));
    check('工具列表仅显示两个可直接执行的入口', { actionCount: capabilities.length, reviewAvailable: true });
    let treeChanges = 0, treeRootLoads = 0;
    const originalChildren = native.capabilityChildren;
    native.capabilityChildren = function (parent) { if (!parent) treeRootLoads++; return originalChildren.call(this, parent); };
    const treeSubscription = native.capabilityEmitter.event(() => { treeChanges++; });
    restored.push(() => { native.capabilityChildren = originalChildren; treeSubscription.dispose(); });
    await vscode.commands.executeCommand('dshPanel.capabilities.focus');
    await new Promise(resolve => setTimeout(resolve, 1600));
    const steadyTree = { changes: treeChanges, loads: treeRootLoads };
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(treeChanges, steadyTree.changes); assert.equal(treeRootLoads, steadyTree.loads);
    check('实际工具视图静置后停止刷新', { observedMs: 1600, changes: treeChanges - steadyTree.changes, reloads: treeRootLoads - steadyTree.loads });
    await vscode.commands.executeCommand('dshPanel.bridge.diagnoseConfig');
    assert(vscode.workspace.textDocuments.some(x => x.uri.path === '/configuration.md' && x.getText().length));
    check('打开真实配置诊断');
    startStep('对话与代码附件');
    let document = await vscode.workspace.openTextDocument(file); const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, document.lineAt(0).text.length);
    const posts = [], post = panel.post;
    panel.post = function (message) { posts.push(message); return post.call(this, message); };
    await vscode.commands.executeCommand('dshPanel.attachSelection');
    assert(posts.some(x => x.type === 'attach' && x.items?.length));
    check('中文及空格路径的选中代码附件', { filename: path.basename(config.sample), selectionAttached: true });
    await panel.onWebviewMessage({ type: 'send', text: '不要读取文件，不调用工具。只回答数字，不添加解释：2+3等于多少？', attachments: [] });
    const responses = [...panel.session.messages.values()].filter(x => x.role === 'assistant' && x.status !== 'running');
    assert(responses.some(x => /^\s*5[。.!]?\s*$/.test(x.text)));
    check('对话发送取得真实模型回复', { expectedAnswerReceived: true, completed: !panel.session.busy });
    const groups = await native.skillChildren(); const skill = groups.flatMap(x => x.items).find(x => x.skill?.name === 'scenario-skill'); assert(skill);
    picks.push({ prompt: '搜索技能', match: item => item.item?.skill.id === skill.skill.id });
    const skillAction = capabilities.find(item => item.id === 'linxin.skill-explorer.list');
    await vscode.commands.executeCommand(skillAction.command.command, ...(skillAction.command.arguments || []));
    assert(vscode.workspace.textDocuments.some(x => x.uri.path.startsWith('/skill/') && x.getText().includes('SCENARIO_SKILL_BODY')));
    check('搜索技能并打开项目正文', { bodyMarkerFound: true });
    const bundled = groups.flatMap(group => group.items).find(item => item.skill.name === 'diagnose-windows-sandbox-acl'); assert(bundled, '内置技能未注册');
    picks.push({ prompt: '搜索技能', match: item => item.item?.skill.id === bundled.skill.id });
    await vscode.commands.executeCommand(skillAction.command.command, ...(skillAction.command.arguments || []));
    const bundledDocument = vscode.workspace.textDocuments.find(document => document.uri.path === `/skill/${encodeURIComponent(bundled.skill.id)}.md`);
    assert(bundledDocument?.getText().length > 100, '内置技能正文未打开');
    check('通过工具入口打开真实内置技能正文', { characters: bundledDocument.getText().length });
    await vscode.commands.executeCommand('dshPanel.bridge.diagnose');
    assert(vscode.workspace.textDocuments.some(x => x.uri.path === '/health.md' && x.getText().includes('技能服务正常') && !x.getText().includes('"ok"')));
    check('技能健康检查打开结果');
    const skillFile = path.join(config.cwd, '.dsh/skills/scenario-skill/SKILL.md'), originalSkill = fs.readFileSync(skillFile, 'utf8');
    picks.push({ prompt: '管理文件技能', match: item => item.action === 'update' }, { prompt: '选择要修改的技能', match: item => item.skill?.name === 'scenario-skill' });
    await vscode.commands.executeCommand('dshPanel.bridge.manageSkills');
    const draft = vscode.window.activeTextEditor.document; assert(native.skillDrafts.has(draft.uri.toString()));
    const draftEdit = new vscode.WorkspaceEdit(); draftEdit.insert(draft.uri, new vscode.Position(draft.lineCount - 1, 0), '\nSCENARIO_EDITED_BODY\n'); await vscode.workspace.applyEdit(draftEdit);
    confirmations.push('取消'); await vscode.commands.executeCommand('dshPanel.bridge.applySkillDraft'); assert.equal(fs.readFileSync(skillFile, 'utf8'), originalSkill); assert(native.skillDrafts.has(draft.uri.toString()));
    check('技能草稿预览后取消保持原文件', { noWriteOnCancel: true, draftPreserved: true });
    await vscode.window.showTextDocument(draft, { preview: false }); confirmations.push('确认应用'); await vscode.commands.executeCommand('dshPanel.bridge.applySkillDraft'); assert(fs.readFileSync(skillFile, 'utf8').includes('SCENARIO_EDITED_BODY')); assert(!native.skillDrafts.has(draft.uri.toString()));
    check('真实草稿差异确认后更新并回读技能', { originalBackedUp: fs.existsSync(path.join(path.dirname(skillFile), '.trash')), bodyUpdated: true });
    picks.push({ prompt: '管理文件技能', match: item => item.action === 'enabled' }, { prompt: '选择要修改的技能', match: item => item.skill?.name === 'scenario-skill' }); confirmations.push('确认应用'); await vscode.commands.executeCommand('dshPanel.bridge.manageSkills'); assert(fs.readFileSync(skillFile, 'utf8').includes('disable-model-invocation: true'));
    check('技能启用状态按扫描来源确认修改');
    picks.push({ prompt: '管理文件技能', match: item => item.action === 'delete' }, { prompt: '选择要修改的技能', match: item => item.skill?.name === 'scenario-skill' }); confirmations.push('确认应用'); await vscode.commands.executeCommand('dshPanel.bridge.manageSkills'); assert(!fs.existsSync(skillFile));
    picks.push({ prompt: '管理文件技能', match: item => item.action === 'restore' }, { prompt: '选择恢复记录', match: item => item.label === 'scenario-skill' }); confirmations.push('确认应用'); await vscode.commands.executeCommand('dshPanel.bridge.manageSkills'); assert(fs.readFileSync(skillFile, 'utf8').includes('SCENARIO_EDITED_BODY'));
    check('删除技能后从恢复记录找回原正文');
    // 技能修改已独立验证；恢复夹具，避免后续代码审查读取技能恢复记录。
    const trash = path.resolve(path.dirname(skillFile), '.trash');
    assert(path.resolve(config.cwd).startsWith(path.resolve(config.folder) + path.sep));
    assert(trash.startsWith(path.resolve(config.cwd) + path.sep));
    if (fs.existsSync(trash)) { assert(!fs.lstatSync(trash).isSymbolicLink()); fs.rmSync(trash, { recursive: true, force: true }); }
    fs.writeFileSync(skillFile, originalSkill);
    check('技能场景收尾恢复独立代码审查范围', { skillRestored: true, generatedRecoveryRecordsRemoved: true });
    const registeredChat = observed.chatRegistration; assert(registeredChat?.participant, '实际宿主未完成原生 Chat 注册');
    const streamText = [], chatStream = { markdown: value => streamText.push(String(value)), progress() {}, button() {} };
    const token = new vscode.CancellationTokenSource();
    const chatResult = await registeredChat.handler({ prompt: '不要读取文件，不调用工具。只回答数字，不添加解释：2+3等于多少？', references: [] }, { history: [] }, chatStream, token.token);
    assert(chatResult.metadata?.dsh); assert(/^\s*5[。.!]?\s*$/.test(streamText.join('')));
    check('实际宿主注册的 Chat 处理器取得真实流式回复', { metadataSaved: true, realReply: true });
    const referenceText=document.getText(),referenceEdit=new vscode.WorkspaceEdit();referenceEdit.insert(file,new vscode.Position(document.lineCount-1,0),'// EDITOR_CONTEXT_TOKEN_7926\n');await vscode.workspace.applyEdit(referenceEdit);
    let referenceReply='';const referenceResult=await registeredChat.handler({prompt:'不调用工具，只阅读附带文件快照。只回答注释中 EDITOR_CONTEXT_TOKEN_ 后的四位数字。',references:[{value:file}]},{history:[]},{markdown:text=>{referenceReply+=text;},progress(){},button(){}},token.token);
    assert(/7926/.test(referenceReply),referenceReply);await api.closeSession(referenceResult.metadata.dsh);
    const reset=new vscode.WorkspaceEdit();reset.replace(file,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),referenceText);await vscode.workspace.applyEdit(reset);await document.save();
    check('真实模型从原生 Chat 引用读取未保存快照',{unsavedMarkerRead:true});
    fs.writeFileSync(skillFile, originalSkill + '\nWhen explicitly selected for this request, reply with MANUAL_SKILL_OK_5831 only. Do not call tools.\n');
    let manualSkill;
    try {
      const choices = await panel.composer.query('/', 'scenario-skill');
      manualSkill = await panel.composer.select(choices.items.find(item => item.label === 'scenario-skill').id);
      assert.equal(manualSkill.kind, 'skill'); assert(manualSkill.text.includes('MANUAL_SKILL_OK_5831'));
    } finally { fs.writeFileSync(skillFile, originalSkill); }
    check('输入框手动选择真实项目技能正文', { manualSkillAttached: true, sourceRestored: true });
    const manualHandle = await api.createSession({ cwd: config.cwd, userInitiated: true }); let manualReply = '';
    try {
      await api.prompt(manualHandle, 'Use the explicitly selected skill for this request. No tools are needed.', { userInitiated: true, attachments: [manualSkill], onEvent: event => { if (event.type === 'text') manualReply += event.delta; } });
      assert(manualReply.includes('MANUAL_SKILL_OK_5831'), manualReply);
    } finally { await api.closeSession(manualHandle); }
    check('真实模型按手动附加技能指令作答', { manualSkillFollowed: true });
    await registeredChat.handler({ command: 'open-panel', prompt: '', references: [] }, { history: [{ result: chatResult }] }, chatStream, token.token); assert.equal(panel.session.sessionId, chatResult.metadata.dsh.sessionId, JSON.stringify({ streamText, notices: posts.filter(message => message.type === 'notice').slice(-3) }));
    const panelHandle = await api.getPanelSession(); assert.equal(panelHandle.sessionId, chatResult.metadata.dsh.sessionId); let apiText = '';
    await api.prompt(panelHandle, '不要调用工具，只回答数字：3+4等于多少？', { userInitiated: true, onEvent: event => { if (event.type === 'text') apiText += event.delta; } }); assert(/^\s*7[。.!]?\s*$/.test(apiText));
    check('Chat metadata 在面板继续同一会话并经公共 API 对话', { sameSession: true, promptStreamReceived: true });
    await registeredChat.handler({ command: 'skills', prompt: '', references: [] }, { history: [{ result: chatResult }] }, chatStream, token.token); assert(streamText.some(text => text.includes('scenario-skill')));
    const freshChat = await registeredChat.handler({ command: 'new', prompt: '', references: [] }, { history: [{ result: chatResult }] }, chatStream, token.token); assert.notEqual(freshChat.metadata.dsh.sessionId, chatResult.metadata.dsh.sessionId); token.dispose();
    check('原生 Chat 技能命令和新对话使用现有连接');
    picks.push({ prompt: '选择审查范围', cancel: true });
    await vscode.commands.executeCommand('dshPanel.bridge.review'); assert.equal(reviewCount(), 0);
    check('关闭审查范围选择框不启动任务', { reviewInvocations: 0 });
    const { repositorySnapshot } = require(path.join(root, 'src/bridge/results'));
    const original = await repositorySnapshot(config.cwd);
    const changesBeforeReview = treeChanges;
    picks.push({ prompt: '选择审查范围', match: item => item.mode === 'worktree' },
      { prompt: '选择审查范围', match: item => item.mode === 'worktree' });
    startStep('真实模型初次审查');
    const firstPromise = vscode.commands.executeCommand('dshPanel.bridge.review');
    await wait(() => native.runningRepositories.size > 0, 10000);
    await vscode.commands.executeCommand('dshPanel.bridge.review');
    assert(errors.some(x => x.includes('已有运行')));
    const first = await firstPromise; assert.equal(first?.status, 'completed'); assert.equal(reviewCount(), 1);
    assert.equal((await repositorySnapshot(config.cwd)).fingerprint, original.fingerprint);
    assert(diagnostics().length); assert(reportFor(first.id)?.getText().length);
    check('未提交变更审查和连续触发保护', { reviewInvocations: 1, findings: diagnostics().length, workspaceUnchanged: true });
    assert.equal(treeChanges, changesBeforeReview);
    check('真实审查进度不刷新工具列表', { toolInvalidations: treeChanges - changesBeforeReview });
    const priorMessageCount = panel.session.messages.size;
    await vscode.commands.executeCommand('dshPanel.bridge.attachReview', first.id);
    const reportAttachment = posts.filter(message => message.type === 'attach').at(-1)?.items?.[0];
    assert.equal(reportAttachment?.kind, 'review'); assert(reportAttachment.text.includes(first.result.findings[0].title));
    assert.equal(panel.session.messages.size, priorMessageCount); assert.equal(reviewCount(), 1);
    check('审查报告附加到现有对话且不自动发送', { reviewInvocations: 1, noAutomaticChatMessage: true });
    const priorAssistantIds = new Set([...panel.session.messages.values()].filter(message => message.role === 'assistant').map(message => message.id));
    await panel.onWebviewMessage({ type: 'send', text: '不调用工具，只阅读附带的代码审查报告。只回答报告第一条发现的优先级，例如P1，不要解释。', attachments: [reportAttachment] });
    const reportReplies = [...panel.session.messages.values()].filter(message => message.role === 'assistant' && !priorAssistantIds.has(message.id));
    assert(reportReplies.some(message => message.text.includes(first.result.findings[0].priority)));
    assert.equal(reviewCount(), 1);
    check('显式发送报告后真实模型读取附件并继续对话', { reportPriorityReceived: true, noNewReviewInvocation: true });
    startStep('真实模型生成修复建议');
    document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
    const sourceBeforeFix=document.getText();picks.push({prompt:'选择一项查看差异',match:()=>true});confirmations.push('cancel');
    const planId=await vscode.commands.executeCommand('dshPanel.bridge.generateFix',first.id,0);assert.equal(typeof planId,'string',errors.at(-1));assert.equal(document.getText(),sourceBeforeFix);assert.equal(fs.readFileSync(config.sample,'utf8'),sourceBeforeFix);
    check('真实模型修复先打开差异且关闭确认不写文件',{planGenerated:true,previewOnly:true});
    picks.push({prompt:'选择一项查看差异',match:()=>true});confirmations.push('应用此项');await vscode.commands.executeCommand('dshPanel.bridge.applyFix',planId);
    document = await vscode.workspace.openTextDocument(file);
    assert(document.isDirty,errors.at(-1)||'应用修复后当前文档没有未保存改动');assert.notEqual(document.getText(),sourceBeforeFix);assert.equal(fs.readFileSync(config.sample,'utf8'),sourceBeforeFix);
    startStep('真实模型保存修复并重新审查');
    const verified=await vscode.commands.executeCommand('dshPanel.bridge.verifyFix',planId);assert.equal(verified?.status,'completed',errors.at(-1));assert.notEqual(verified.id,first.id);assert.notEqual(verified.fingerprint,first.fingerprint);await vscode.commands.executeCommand('dshPanel.bridge.remove',verified.id);
    check('真实模型修复逐项确认后保存并重新审查',{editorChanged:true,diskChangedAfterSave:true,newReview:true});
    if(config.featuresOnly){write('editor-result.json',{status:'passed',checks,editor:vscode.version,scope:'feature-updates'});await vscode.commands.executeCommand('workbench.action.closeWindow');return;}
    const resetFix=new vscode.WorkspaceEdit();resetFix.replace(file,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),sourceBeforeFix);await vscode.workspace.applyEdit(resetFix);await document.save();
    // 恢复当前夹具快照后继续验证独立的报告重试与恢复场景。
    await native.presentReport(first.id,first.result);
    await vscode.window.showTextDocument(reportFor(first.id), { preview: false });
    const beforeEdit = await vscode.workspace.openTextDocument(file), edit = new vscode.WorkspaceEdit();
    edit.insert(file, new vscode.Position(0, 0), '// 场景测试修改\n'); await vscode.workspace.applyEdit(edit); await beforeEdit.save();
    await wait(() => diagnostics().length === 0, 5000);
    check('保存修改立即清除过期问题定位');
    startStep('真实模型显式重试审查');
    const retry = await vscode.commands.executeCommand('dshPanel.bridge.retry', first.id);
    assert.equal(retry?.status, 'completed'); assert.notEqual(retry.id, first.id); assert.notEqual(retry.fingerprint, first.fingerprint);
    const newer = diagnostics().length; assert(newer);
    assert(vscode.workspace.textDocuments.some(x => x.uri.path === '/retry-preview.md'));
    check('显式重试显示预览并建立新运行', { newIdentity: true, newSnapshot: true, findings: newer });
    await vscode.commands.executeCommand('dshPanel.bridge.remove', first.id); assert.equal(diagnostics().length, newer);
    check('删除旧记录保留新审查发现', { findings: newer });
    assert.equal(await clean(), 1); assert.equal(diagnostics().length, 0); assert(reportFor(first.id)?.getText().length);
    check('清理已结束记录保留已打开报告');
    const chatReviewText = [], chatReviewToken = new vscode.CancellationTokenSource();
    startStep('真实模型原生 Chat 审查');
    await registeredChat.handler({ command: 'review', prompt: '', references: [] }, { history: [] }, { markdown: text => chatReviewText.push(text), progress() {}, button() {} }, chatReviewToken.token);
    assert(chatReviewText.join('').includes('代码审查')); assert([...native.operations.values()].some(op => op.status === 'completed')); assert.equal(await clean(), 1); chatReviewToken.dispose();
    check('原生 Chat 审查命令返回真实审查报告');
    const beforeInvalid = reviewCount(); await assert.rejects(api.review({ cwd: config.cwd, input: { mode: 'base', ref: 'scenario-ref-does-not-exist' }, userInitiated: true }), error => error.code === -32051);
    assert.equal(reviewCount(), beforeInvalid);
    check('无效分支在调用模型前拦截');
    const cancelling = api.review({ cwd: config.cwd, input: { mode: 'worktree' }, userInitiated: true });
    const cancelled = await wait(() => [...native.operations.values()].find(x => x.status === 'running'), 15000);
    await vscode.commands.executeCommand('dshPanel.bridge.cancel', cancelled.id);
    const cancelResult = await cancelling; assert.equal(cancelResult.status, 'cancelled');
    assert.equal(diagnostics().length, 0); assert.equal(await clean(), 1);
    check('真实运行可以取消并清理', { status: cancelResult.status });
    const recovering = api.review({ cwd: config.cwd, input: { mode: 'worktree' }, userInitiated: true }); recovering.catch(() => {});
    const active = await wait(() => [...native.operations.values()].find(x => x.status === 'running'), 15000);
    await native.saveActive();
    const saved = native.context.workspaceState.get('dshPanel.bridge.records.v2'); assert(saved.records.some(x => x.id === active.id));
    check('进行中的审查保存恢复元数据', { status: active.status });
    write('running-checkpoint.json', { id: active.id, instanceId: connection.instanceId, clientId: native.connections.clientId, pid: endpoint.pid });
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  };
  try {
    await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`编辑器使用场景超时${activeStep ? `：${activeStep}` : ''}`)), config.actorTimeoutMs || 360000); })]);
  } catch (error) { write('editor-result.json', { status: 'failed', phase, checks, activeStep, elapsedMs: Date.now() - phaseStarted, error: String(error.stack || error) }); }
  finally { clearTimeout(timer); for (const restore of restored.reverse()) restore(); }
};
