'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, locate, redact, sha256 } = require('../compat/lib.cjs');
const { isolatedEditorOptions, ownsEditorProcess, editorProcessRoots } = require('../../packages/vscode-extension/tools/editor-isolation.cjs');
const { probeEditorContext, requireEditorContext, installedEditor } = require('./editor-context.cjs');

/** Report outputs and the owned runtime home have separate paths. */
function editorHomeCheck({ folder, runtimeHome }) {
  const reportFolder = path.resolve(folder), underBuild = path.relative(path.join(ROOT, 'build'), reportFolder);
  assert(underBuild && underBuild !== '..' && !underBuild.startsWith('..' + path.sep) && !path.isAbsolute(underBuild), '验收目录必须位于本项目 build 内');
  assert(typeof runtimeHome === 'string' && path.isAbsolute(runtimeHome), '需要显式提供隔离运行时 home');
  assert.equal(runtimeHome, path.resolve(runtimeHome), '运行时 home 必须是规范绝对路径');
  const relative = path.relative(reportFolder, runtimeHome).split(path.sep);
  assert(relative.length === 1 && relative[0] === 'home'
    || relative.length === 2 && /^work-[A-Za-z0-9]+$/.test(relative[0]) && relative[1] === 'home', '运行时 home 不属于本次验收目录');
  require('../run-resources.cjs').plainParents(runtimeHome);
  assert(fs.statSync(runtimeHome).isDirectory(), '运行时 home 必须存在');
  assert.equal(process.env.DSH_HOME, runtimeHome, 'DSH_HOME 与本次运行时 home 不一致');
  return `check('isolated endpoint home',process.env.DSH_HOME===${JSON.stringify(runtimeHome)});`;
}

async function checkEditor({ folder, cwd, port, vsix, runtimeHome }) {
  const homeCheck = editorHomeCheck({ folder, runtimeHome });
  assert.equal(typeof vsix, 'string', '需要显式提供候选 VSIX');
  assert(fs.statSync(vsix).isFile(), '候选 VSIX 不存在');
  const candidateSha256 = sha256(vsix);
  const code = process.env.DSH_PANEL_CODE || installedEditor();
  const editorContext = probeEditorContext({ code, folder });
  // Electron 的命令行 Node 和图形扩展宿主可能处于不同的完整性级别。
  // 默认启动的真实宿主会再次核对端点；预探测不能替代实际功能验收。
  if (editorContext.status === 'unavailable') requireEditorContext(editorContext);
  const panelVersion = require('../../packages/vscode-extension/package.json').version;
  const extracted = path.join(folder, 'vsix');
  const quote = text => `'${text.replace(/'/g, "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(vsix)}, ${quote(extracted)})`], { windowsHide: true });
  const extensions = path.join(folder, 'editor-extensions'), userData = path.join(folder, 'editor-data'), sharedData = path.join(folder, 'editor-shared-data');
  fs.mkdirSync(extensions); fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.renameSync(path.join(extracted, 'extension'), path.join(extensions, `Elk-ydy.dsh-acp-panel-${panelVersion}`));
  const panelRoot = path.join(ROOT, 'packages/vscode-extension');
  require('../../packages/vscode-extension/tools/package-links.cjs').verifyPackageFiles(panelRoot,
    path.join(extensions, `Elk-ydy.dsh-acp-panel-${panelVersion}`));
  const extensionEntry = path.join(extensions, `Elk-ydy.dsh-acp-panel-${panelVersion}`, 'src/extension.js');
  const extensionSource = fs.readFileSync(extensionEntry, 'utf8');
  assert.equal(extensionSource.split('  return api.exports;').length, 2);
  assert.equal(extensionSource.split('  const view = new DshPanelView({').length, 2);
  fs.writeFileSync(extensionEntry, extensionSource
    .replace('  const view = new DshPanelView({', '  const startupEditor = vscode.window.activeTextEditor;\n  const view = new DshPanelView({')
    .replace('  return api.exports;', "  process[Symbol.for('dsh.validation.observer')] = { nativeViews, view, vscode, chatRegistration, startupEditor };\n  return api.exports;"));
  const viewsEntry = path.join(extensions, `Elk-ydy.dsh-acp-panel-${panelVersion}`, 'src/bridge/views.js');
  const viewsSource = fs.readFileSync(viewsEntry, 'utf8').replace(/\r\n/g, '\n');
  const treeRegistration = "vscode.window.registerTreeDataProvider('dshPanel.capabilities', { onDidChangeTreeData: this.capabilityEmitter.event,\n        getTreeItem: item => item, getChildren: item => this.capabilityChildren(item) }),";
  assert(viewsSource.includes(treeRegistration), '隔离树视图观察点与当前源码不一致');
  fs.writeFileSync(viewsEntry, viewsSource.replace(treeRegistration, "process[Symbol.for('dsh.validation.tree')] = vscode.window.createTreeView('dshPanel.capabilities', { treeDataProvider: { onDidChangeTreeData: this.capabilityEmitter.event, getTreeItem: item => item, getParent: () => undefined, getChildren: item => this.capabilityChildren(item) } }),"));
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false,
    'dshPanel.port': port, 'dshPanel.selfStartPort': port, 'dshPanel.autoStart': false, 'workbench.startupEditor': 'none',
    'update.mode': 'none', 'extensions.autoUpdate': false }));
  const checker = path.join(extensions, 'bridge-checker'); fs.mkdirSync(checker);
  fs.writeFileSync(path.join(checker, 'package.json'), JSON.stringify({ name: 'bridge-checker', publisher: 'local', version: '1.0.0',
    engines: { vscode: '^1.85.0' }, main: './index.js', activationEvents: ['onStartupFinished'], extensionDependencies: ['Elk-ydy.dsh-acp-panel'] }));
  const resultFile = path.join(folder, 'editor-result.json');
  const closingFile = path.join(folder, 'editor-closing.json');
  const progressFile = path.join(folder, 'editor-progress.json');
  fs.writeFileSync(path.join(checker, 'index.js'), `'use strict';
const vscode = require('vscode'), fs = require('node:fs');
exports.activate = () => { setTimeout(() => void run(), 0); };
async function run() {
  const checks = []; const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); fs.writeFileSync(${JSON.stringify(progressFile)},JSON.stringify({checks})); };
  try {
    const extension = vscode.extensions.getExtension('Elk-ydy.dsh-acp-panel');
    const api = await extension.activate(); check('extension activation', api.apiVersion === 1);
    const observed=process[Symbol.for('dsh.validation.observer')]; check('isolated observation loaded',!!observed);
    const startupEditor=await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(path.join(cwd, 'sample.js'))}),{preview:false});
    check('native file editor opens',startupEditor.document.uri.fsPath.toLowerCase()===${JSON.stringify(path.join(cwd, 'sample.js').toLowerCase())});
    await new Promise(resolve=>setTimeout(resolve,50));
    check('composer captures opened editor',observed.view.composer.recentEditor?.document===startupEditor.document);
    if (fs.existsSync(${JSON.stringify(closingFile)})) {
      await observed.nativeViews.historyReady;
      const saved=JSON.parse(fs.readFileSync(${JSON.stringify(closingFile)}));
      const offline=observed.nativeViews.operations.get('history-'+saved.savedKey);
      check('window reopen keeps complete saved report',offline?.result?.findings?.[0]?.title?.includes('Incorrect sum'));
      const connect=observed.nativeViews.connections.ensure;observed.nativeViews.connections.ensure=()=>{throw new Error('Offline history must not connect');};
      try {await observed.nativeViews.openReport(offline.id);await observed.nativeViews.openCase(offline.id);check('offline saved repair and test history',(await observed.nativeViews.caseText(offline.caseKey)).includes('所选测试通过'));}
      finally {observed.nativeViews.connections.ensure=connect;}
      await api.listCapabilities();
      const draftKey=require(require('node:path').join(extension.extensionPath,'src/panel/drafts.js')).draftKey;
      check('window reopen restores draft',observed.view.workspaceState.get(draftKey(${JSON.stringify(cwd)}))?.text==='NATIVE_DRAFT_FIXTURE');
      const deadline = Date.now()+20000;
      while(!vscode.workspace.textDocuments.some(doc=>doc.uri.scheme==='dsh-result'&&doc.getText().includes('Incorrect sum'))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
      check('window reopen restores review',vscode.workspace.textDocuments.some(doc=>doc.uri.scheme==='dsh-result'&&doc.getText().includes('Incorrect sum')));
      const previous=JSON.parse(fs.readFileSync(${JSON.stringify(closingFile)}));
      fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'passed',checks:[...previous.checks,...checks],vscode:vscode.version}));
      return;
    }
    const commands = await vscode.commands.getCommands(true);
    check('no editor completion commands', !commands.some(command => command.startsWith('dshPanel.completion.')));
    check('no editor completion payload', !fs.existsSync(require('node:path').join(extension.extensionPath, 'src/inline')));
    check('native commands', ['review','skills','refresh','cancel','openReport','diagnoseConfig','copyDiagnostics','installGuide','retry','remove','clearFinished','reviewTask','checkReview','runReviewTests','reviewTestLog'].every(key => commands.includes('dshPanel.bridge.'+key)));
    await vscode.commands.executeCommand('dshPanel.capabilities.focus');
    const catalog = await api.listCapabilities(); check('runtime providers', catalog.capabilities.length >= 7);
    const status = await api.getConnectionStatus(); check('one shared connection', status.connectionCount === 1);
    check('no code completion capability', !observed.nativeViews.connections.status.capabilities.codeCompletion && !observed.nativeViews.connections.status.capabilities.completionWorkspaceContext);
    ${homeCheck}
    const endpointFile=require('node:path').join(process.env.DSH_HOME,'run','dsh-acp-door',${JSON.stringify(String(port) + '.json')});
    const endpointCheck={exists:fs.existsSync(endpointFile),node:process.version};
    try {
      const record=JSON.parse(fs.readFileSync(endpointFile,'utf8')),stat=fs.lstatSync(endpointFile);
      endpointCheck.file=stat.isFile(); endpointCheck.symlink=stat.isSymbolicLink(); endpointCheck.instanceMatches=record.instanceId===status.instanceId; endpointCheck.portMatches=record.port===${JSON.stringify(port)};
      endpointCheck.queryAlive=await require(require('node:path').join(extension.extensionPath,'src/bridge/process.js')).queryWindows(record.pid);
    } catch(error) { endpointCheck.queryError=String(error.code||error.message); }
    fs.writeFileSync(${JSON.stringify(path.join(folder, 'editor-endpoint-check.json'))},JSON.stringify(endpointCheck));
    await vscode.commands.executeCommand('dshPanel.bridge.diagnoseConfig');
    const diagnosis = vscode.workspace.textDocuments.find(doc=>doc.uri.path==='/configuration.md');
    check('native configuration diagnosis',diagnosis&&diagnosis.getText().includes('磁盘安装清单与内核实际能力分别列出'));
    check('native model configuration diagnosis',diagnosis.getText().includes('会话模型配置'));
    await observed.view.onWebviewMessage({type:'draft',draft:{version:1,cwd:${JSON.stringify(cwd)},savedAt:Date.now(),text:'NATIVE_DRAFT_FIXTURE',attachments:[{kind:'content',name:'scratch.js',text:'UNSAVED_DRAFT_FIXTURE'}]}});await observed.view.draftWrites;
    const draftKey=require(require('node:path').join(extension.extensionPath,'src/panel/drafts.js')).draftKey;
    check('native draft persistence',observed.view.workspaceState.get(draftKey(${JSON.stringify(cwd)}))?.attachments[0].text==='UNSAVED_DRAFT_FIXTURE');
    const previousClipboard=await vscode.env.clipboard.readText();
    try{
      await vscode.commands.executeCommand('dshPanel.bridge.copyDiagnostics');
      check('diagnosis clipboard', (await vscode.env.clipboard.readText())===diagnosis.getText());
    }finally{await vscode.env.clipboard.writeText(previousClipboard);}
    for(const [theme,kind] of [['Default Light Modern',1],['Default Dark Modern',2],['Default High Contrast',3]]) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      const themeDeadline=Date.now()+5000;
      while(vscode.window.activeColorTheme.kind!==kind&&Date.now()<themeDeadline) await new Promise(resolve=>setTimeout(resolve,50));
      check('editor active theme '+kind,vscode.window.activeColorTheme.kind===kind);
      await vscode.commands.executeCommand('dshPanel.capabilities.focus');
      await vscode.commands.executeCommand('dshPanel.operations.focus');
    }
    await vscode.commands.executeCommand('dshPanel.capabilities.focus');
    const capabilityTree=process[Symbol.for('dsh.validation.tree')];
    const keyboardItems=await observed.nativeViews.capabilityChildren();
    const keyboardObservation={items:keyboardItems.map(item=>item.id),events:[]};
    capabilityTree.onDidChangeSelection(event=>keyboardObservation.events.push(event.selection.map(item=>item.id)));
    check('native keyboard tree observation',!!capabilityTree&&keyboardItems.length>=2);
    await capabilityTree.reveal(keyboardItems[0],{select:true,focus:true});
    keyboardObservation.initial=capabilityTree.selection.map(item=>item.id);
    await vscode.commands.executeCommand('list.focusDown');
    keyboardObservation.afterDown=capabilityTree.selection.map(item=>item.id);
    await vscode.commands.executeCommand('list.toggleSelection');
    keyboardObservation.afterToggle=capabilityTree.selection.map(item=>item.id);
    const keyboardDeadline=Date.now()+3000;
    while(!capabilityTree.selection.some(item=>item.id===keyboardItems[1].id)&&Date.now()<keyboardDeadline) await new Promise(resolve=>setTimeout(resolve,30));
    keyboardObservation.final=capabilityTree.selection.map(item=>item.id);
    fs.writeFileSync(${JSON.stringify(path.join(folder, 'editor-keyboard.json'))},JSON.stringify(keyboardObservation));
    check('native keyboard changes tree selection',keyboardObservation.initial.length===1&&keyboardObservation.initial[0]===keyboardItems[0].id&&capabilityTree.selection.some(item=>item.id===keyboardItems[1].id));
    await capabilityTree.reveal(keyboardItems[1],{select:true,focus:true});
    await vscode.commands.executeCommand('list.focusUp');
    await vscode.commands.executeCommand('list.toggleSelection');
    const keyboardReturnDeadline=Date.now()+3000;
    while(!capabilityTree.selection.some(item=>item.id===keyboardItems[0].id)&&Date.now()<keyboardReturnDeadline) await new Promise(resolve=>setTimeout(resolve,30));
    check('native keyboard returns tree selection',capabilityTree.selection.some(item=>item.id===keyboardItems[0].id));
    await capabilityTree.reveal(keyboardItems[0],{select:true,focus:true});
    await vscode.workspace.getConfiguration('workbench').update('reduceMotion','on',vscode.ConfigurationTarget.Global);
    check('editor reduced motion configuration',vscode.workspace.getConfiguration('workbench').get('reduceMotion')==='on');
    if(${process.env.DSH_PANEL_EXPECT_NATIVE_RESTRICTION === '1'}) {
      let nativeError;try{await api.review({cwd:${JSON.stringify(cwd)},input:{mode:'worktree'},userInitiated:true});}catch(error){nativeError=error;}
      check('unconfirmed identity restricts native execution',nativeError&&nativeError.code===-32052);
      const path=require('node:path');
      const {DoorClient}=require(path.join(extension.extensionPath,'src/door/client.js'));
      const {DshSession}=require(path.join(extension.extensionPath,'src/dsh/session.js'));
      const client=new DoorClient({host:'127.0.0.1',port:${JSON.stringify(port)}});await client.connect();
      const session=new DshSession({client});let answer='';session.on('text',text=>{answer+=typeof text==='string'?text:text?.delta||'';});
      try{await session.start({cwd:${JSON.stringify(cwd)},preset:'standard'});await session.send('Reply with HELLO only.');check('ordinary chat after native restriction',answer.length>0);}finally{session.dispose();client.close();}
      fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'passed',checks,vscode:vscode.version,nativeMode:'restricted',limitations:['Native review identity check did not pass']}));return;
    }
    const localSkillFile=require('node:path').join(${JSON.stringify(cwd)},'.agents/skills/local-fixture/SKILL.md');fs.mkdirSync(require('node:path').dirname(localSkillFile),{recursive:true});fs.writeFileSync(localSkillFile,'# Local fixture\\nLOCAL_SKILL_FIXTURE');
    const workflowFile=require('node:path').join(${JSON.stringify(cwd)},'workflow.txt');fs.writeFileSync(workflowFile,'existing local content');
    const tasksFile=require('node:path').join(${JSON.stringify(cwd)},'.vscode/tasks.json');fs.mkdirSync(require('node:path').dirname(tasksFile),{recursive:true});fs.writeFileSync(tasksFile,JSON.stringify({version:'2.0.0',tasks:[
      {label:'DSH workflow pass',type:'process',command:${JSON.stringify(process.execPath)},args:['-e','process.exit(0)'],group:'test',problemMatcher:[]},
      {label:'DSH workflow fail',type:'process',command:${JSON.stringify(process.execPath)},args:['-e','process.exit(1)'],group:'test',problemMatcher:[]},
      {label:'DSH workflow cancel',type:'process',command:${JSON.stringify(process.execPath)},args:['-e','setTimeout(()=>{},30000)'],group:'test',problemMatcher:[]},
      {label:'DSH repair regression',type:'process',command:${JSON.stringify(process.execPath)},args:['--input-type=module','-e',${JSON.stringify(`import {sum} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(cwd, 'sample.js')).href)}; if(sum(2,3)!==5) process.exit(1);`)}],group:'test',problemMatcher:[]}
    ]}));
    const ComposerContext=require(require('node:path').join(extension.extensionPath,'src/panel/completions.js')).ComposerContext;
    const offlineComposer=new ComposerContext({vscode,workdir:()=>${JSON.stringify(cwd)},connected:()=>false,invoke:()=>{throw new Error('Offline completion must not invoke a provider');}});
    const localChoices=await offlineComposer.query('/','local-fixture');check('native composer offline project skill search',localChoices.items.length===1);
    const localSkill=await offlineComposer.select(localChoices.items[0].id);check('native composer offline project skill body',localSkill.kind==='skill'&&localSkill.text.includes('LOCAL_SKILL_FIXTURE'));
    const first=await api.review({cwd:${JSON.stringify(cwd)},input:{mode:'worktree'},userInitiated:true});
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(${JSON.stringify(path.join(cwd, 'sample.js'))}));
    check('Problems finding', diagnostics.length === 1 && diagnostics[0].range.start.line === 0 && diagnostics[0].severity === vscode.DiagnosticSeverity.Warning);
    check('native full report', vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'dsh-result' && doc.getText().includes('Incorrect sum')));
    await vscode.commands.executeCommand('dshPanel.operations.focus');
    check('run view', true);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path.join(cwd, 'sample.js'))}));
    const panelApi=observed.vscode,originalText=document.getText();
    const baselinePick=panelApi.window.showQuickPick;panelApi.window.showQuickPick=async items=>items.find(item=>item.label==='DSH repair regression');
    try {
      check('review baseline has no chat turn',!observed.view.workflow.latest);
      const baseline=await observed.nativeViews.verification.run(first);await baseline.finished;
      check('real repair baseline test fails',baseline.status==='failed'&&baseline.exitCode===1&&baseline.cwd===${JSON.stringify(cwd)});
    }finally{panelApi.window.showQuickPick=baselinePick;}
    const referenceEdit=new vscode.WorkspaceEdit();referenceEdit.insert(document.uri,new vscode.Position(1,0),'// CHAT_REFERENCE_UNSAVED_MARKER\\n');await vscode.workspace.applyEdit(referenceEdit);
    check('reference document is unsaved',document.isDirty);
    const composer=observed.view.composer;
    const files=await composer.query('@','sample');
    const fileChoice=files.items.find(item=>item.label==='sample.js');
    check('native composer workspace file search',!!fileChoice);
    const fileSnapshot=await composer.select(fileChoice.id);
    check('native composer unsaved file snapshot',fileSnapshot.text.includes('CHAT_REFERENCE_UNSAVED_MARKER')&&!fileSnapshot.uri);
    await vscode.window.showTextDocument(document);
    vscode.window.activeTextEditor.selection=new vscode.Selection(0,0,0,6);
    const contexts=await composer.query('#','selection');
    const selectedSnapshot=await composer.select(contexts.items[0].id);
    check('native composer selection snapshot',selectedSnapshot.kind==='selection'&&selectedSnapshot.text==='export');
    const skills=await composer.query('/','bridge-fixture');
    const skillSnapshot=await composer.select(skills.items[0].id);
    check('native composer manual skill attachment',skillSnapshot.kind==='skill'&&skillSnapshot.text.includes('BRIDGE_SKILL_CONTENT'));
    const gitChoices=await composer.query('@','context-git',undefined,{origin:'context',source:'diff'});
    const gitChoice=gitChoices.items.find(item=>item.label==='context-git.txt'&&item.description==='未暂存变更');
    const gitSnapshot=await composer.select(gitChoice.id);
    check('native composer Git diff snapshot',gitSnapshot.scope==='git-diff'&&gitSnapshot.text.includes('+context-working')&&!gitSnapshot.text.includes('CHAT_REFERENCE_UNSAVED_MARKER'));
    const contextDiagnostics=vscode.languages.createDiagnosticCollection('dsh-context-fixture');
    contextDiagnostics.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,6),'CONTEXT_DIAGNOSTIC_MARKER',vscode.DiagnosticSeverity.Warning)]);
    try {
      const diagnosticChoices=await composer.query('@','sample',undefined,{origin:'context',source:'diagnostics'});
      const diagnosticSnapshot=await composer.select(diagnosticChoices.items.find(item=>item.label==='sample.js').id);
      check('native composer Problems snapshot',diagnosticSnapshot.scope==='diagnostics'&&diagnosticSnapshot.text.includes('CONTEXT_DIAGNOSTIC_MARKER')&&diagnosticSnapshot.text.includes('未保存编辑'));
      contextDiagnostics.clear();check('native composer immutable context',diagnosticSnapshot.text.includes('CONTEXT_DIAGNOSTIC_MARKER')&&gitSnapshot.text.includes('+context-working'));
      const {snapshotMessage}=require(${JSON.stringify(path.join(panelRoot,'src/panel/queue'))});
      check('native composer context queue',snapshotMessage('inspect',[gitSnapshot,diagnosticSnapshot]).attachments[1].source==='vscode-diagnostics');
      const contextSession=await api.createSession({cwd:${JSON.stringify(cwd)},userInitiated:true});let contextAnswer='';
      try {await api.prompt(contextSession,'Acknowledge the attached context',{userInitiated:true,attachments:[gitSnapshot,diagnosticSnapshot],onEvent:event=>{if(event.type==='text')contextAnswer+=event.delta;}});check('native composer context transmission',contextAnswer.length>0);}
      finally{await api.closeSession(contextSession);}
    }finally{contextDiagnostics.dispose();}
    const chat=observed.chatRegistration;let reply='',chatResult;
    if(chat?.handler){
      check('native participant registered',true);
      const chatCancel=new vscode.CancellationTokenSource();
      try{chatResult=await chat.handler({prompt:'Explain the attached file',references:[{value:document.uri}]},{history:[]},{markdown:delta=>{reply+=delta;},progress(){},button(){}},chatCancel.token);}
      finally{chatCancel.dispose();}
      check('native Chat receives unsaved file reference',reply.includes('CHAT_REFERENCE_UNSAVED_MARKER'));
    }else{
      check('native Chat unavailable keeps sidebar',Number(vscode.version.split('.')[1])<91&&!!observed.view.composer);
      const handle=await api.createSession({cwd:${JSON.stringify(cwd)},userInitiated:true});
      chatResult={metadata:{dsh:handle}};
      await api.prompt(handle,'Explain the attached file',{userInitiated:true,attachments:[fileSnapshot],onEvent:event=>{if(event.type==='text')reply+=event.delta;}});
      check('sidebar receives unsaved file reference',reply.includes('CHAT_REFERENCE_UNSAVED_MARKER'));
    }
    fs.writeFileSync(${JSON.stringify(path.join(folder, 'chat-reference-result.json'))},JSON.stringify({reply,chatResult}));
    await api.closeSession(chatResult.metadata.dsh);
    const resetReference=new vscode.WorkspaceEdit();resetReference.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),originalText);await vscode.workspace.applyEdit(resetReference);await document.save();
    const slashChoices=await composer.query('/','status');check('native slash commands',slashChoices.items.some(item=>item.kind==='command'&&item.id==='command:status'));
    const workflow=observed.view.workflow,tracked=await workflow.begin();fs.writeFileSync(workflowFile,'native agent content');await workflow.finish(tracked);
    const changed=tracked.files.find(item=>item.name==='workflow.txt');check('native workflow baseline',changed?.before.text==='existing local content'&&changed.after.text==='native agent content');
    await workflow.preview(changed.id);check('native workflow diff',vscode.workspace.textDocuments.some(doc=>doc.uri.scheme==='dsh-turn'&&doc.getText()==='native agent content'));
    observed.view.newSessionPending=Promise.resolve();let switchUndoRefused=false;try{await workflow.undo(changed.id);}catch(error){switchUndoRefused=/当前任务/.test(error.message);}finally{observed.view.newSessionPending=null;}check('native session switch blocks undo',switchUndoRefused&&fs.readFileSync(workflowFile,'utf8')==='native agent content');
    const workflowInfo=panelApi.window.showInformationMessage,workflowPick=panelApi.window.showQuickPick;
    try{
      panelApi.window.showInformationMessage=async()=> '撤销此文件';await workflow.undo(changed.id);
      const workflowDocument=await vscode.workspace.openTextDocument(vscode.Uri.file(workflowFile));check('native workflow undo',workflowDocument.isDirty&&workflowDocument.getText()==='existing local content'&&fs.readFileSync(workflowFile,'utf8')==='native agent content');await workflowDocument.save();
      const conflict=await workflow.begin();fs.writeFileSync(workflowFile,'native second change');await workflow.finish(conflict);fs.writeFileSync(workflowFile,'later user content');
      let refused=false;try{await workflow.undo(conflict.files.find(item=>item.name==='workflow.txt').id);}catch(error){refused=/又被修改/.test(error.message);}check('native workflow undo conflict',refused&&fs.readFileSync(workflowFile,'utf8')==='later user content');fs.writeFileSync(workflowFile,'existing local content');
      const awaitTest=async()=>{const until=Date.now()+15000;while(workflow.activeTest&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));if(workflow.activeTest)throw new Error('Native task completion timed out');};
      panelApi.window.showQuickPick=async items=>items.find(item=>item.label==='DSH workflow pass');await observed.view.tests.run();await awaitTest();check('native test task pass',workflow.testResult.status==='passed'&&workflow.testResult.exitCode===0);
      panelApi.window.showQuickPick=async items=>items.find(item=>item.label==='DSH workflow fail');await observed.view.tests.run();await awaitTest();check('native test task fail',workflow.testResult.status==='failed'&&workflow.testResult.exitCode===1);
      const testIdentity=result=>({testId:result.id,turnId:result.turnId,requestId:'native-test-'+result.id});
      const attached=[];let evidence;const previousAttach=observed.view.attach;observed.view.attach=async items=>attached.push(...items);try{evidence=await observed.view.tests.attach(testIdentity(workflow.testResult));}finally{observed.view.attach=previousAttach;}check('native test result attachment',evidence.items[0]?.text.includes('结果：失败')&&evidence.items[0].text.includes('退出码：1')&&evidence.items[0].testId===workflow.testResult.id&&attached.length===0);
      panelApi.window.showQuickPick=async items=>items.find(item=>item.label==='DSH workflow cancel');await observed.view.tests.run();
      const currentSession=observed.view.session,previousTurn=workflow.latest,currentTest=workflow.testResult;
      await observed.view.resumeHistory(currentSession.sessionId);check('native test blocks history switch',workflow.activeTest&&workflow.latest===previousTurn&&workflow.testResult===currentTest);
      let adoptRefused=false;try{await observed.view.adoptSession(currentSession,{cwd:${JSON.stringify(cwd)}});}catch{adoptRefused=true;}check('native test blocks session adoption',adoptRefused&&workflow.activeTest&&workflow.latest===previousTurn);
      observed.view.tests.cancel(testIdentity(currentTest));await awaitTest();check('native test task cancellation',workflow.testResult.status==='cancelled');
      panelApi.window.showQuickPick=async(items,options)=>{if(options?.placeHolder==='选择当前对话模型'){await observed.view.tests.run();return items[0];}return items.find(item=>item.label==='DSH workflow cancel');};
      let modelRefused=false;try{await observed.view.executeComposerCommand('command:model');}catch(error){modelRefused=/已变化/.test(error.message);}check('native model picker rechecks running task',modelRefused&&workflow.activeTest);observed.view.tests.cancel(testIdentity(workflow.testResult));await awaitTest();
      const historyTarget=chatResult.metadata.dsh.sessionId;
      const savedHistory=await observed.view.readHistory('get',historyTarget);check('native history target has a completed turn',savedHistory.result.entries.some(entry=>entry.kind==='assistant'));
      await observed.view.resumeHistory(historyTarget);check('native history clears workflow records',!workflow.latest&&!workflow.testResult&&!workflow.activeTest&&observed.view.session.sessionId===historyTarget&&!observed.view.historyReadonly);
    }finally{panelApi.window.showInformationMessage=workflowInfo;panelApi.window.showQuickPick=workflowPick;}
    await observed.nativeViews.presentReport(first.id,first.result);
    const history=await observed.view.client.listHistory({cwd:${JSON.stringify(cwd)},limit:1});
    check('native history pagination',history.sessions.length===1&&history.total>=2&&history.nextOffset===1);
    const selectedHistory=await observed.view.client.listHistory({query:history.sessions[0].id,cwd:${JSON.stringify(cwd)}});check('native history search',selectedHistory.total===1);
    const saveDialog=panelApi.window.showSaveDialog;panelApi.window.showSaveDialog=async()=>vscode.Uri.file(${JSON.stringify(path.join(folder, 'conversation-export.md'))});
    try{await observed.view.exportHistory(history.sessions[0].id);check('native Markdown export',fs.readFileSync(${JSON.stringify(path.join(folder, 'conversation-export.md'))},'utf8').includes('# '));}finally{panelApi.window.showSaveDialog=saveDialog;}
    const codeActions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',document.uri,new vscode.Range(0,0,0,document.lineAt(0).text.length));
    check('finding quick fix action',codeActions.some(action=>action.command?.command==='dshPanel.bridge.generateFix'));
    const pick=panelApi.window.showQuickPick,info=panelApi.window.showInformationMessage;let approve=false,diffOpened=false;
    panelApi.window.showQuickPick=async items=>(await items)[0];panelApi.window.showInformationMessage=async(_message,...choices)=>choices.includes('应用此项')&&approve?'应用此项':undefined;
    try{
      const planId=await vscode.commands.executeCommand('dshPanel.bridge.generateFix',first.id,0);
      check('fix preview without source mutation',typeof planId==='string'&&document.getText()===originalText&&fs.readFileSync(document.uri.fsPath,'utf8')===originalText);
      check('native diff preview',vscode.workspace.textDocuments.some(doc=>doc.uri.path.includes('/fix/')&&doc.getText().includes('a + b')));
      approve=true;await vscode.commands.executeCommand('dshPanel.bridge.applyFix',planId);
      check('approved single fix stays unsaved',document.isDirty&&document.getText().includes('a + b')&&fs.readFileSync(document.uri.fsPath,'utf8')===originalText);
      const verified=await vscode.commands.executeCommand('dshPanel.bridge.verifyFix',planId);
      check('save and review uses new snapshot',verified?.status==='completed'&&verified.id!==first.id&&verified.fingerprint!==first.fingerprint&&fs.readFileSync(document.uri.fsPath,'utf8').includes('a + b'));
      panelApi.window.showQuickPick=async items=>items.find(item=>item.label==='DSH repair regression');
      const ordinaryTest=workflow.testResult;
      const verification=observed.nativeViews.verification;let verificationTimer;
      let passed;
      try{passed=await Promise.race([(async()=>{const result=await verification.run(first);await result.finished;return result;})(),new Promise((_,reject)=>{verificationTimer=setTimeout(()=>reject(new Error('Repair test did not finish: '+JSON.stringify({selecting:verification.selecting,current:verification.current?.status,execution:verification.execution?.task?.name,tasks:vscode.tasks.taskExecutions.map(item=>item.task.name)}))),30000);})]);}
      finally{clearTimeout(verificationTimer);}
      check('independent repair test passes',passed.status==='passed'&&passed.exitCode===0&&passed.cwd===first.cwd&&workflow.testResult===ordinaryTest);
      check('repair and re-review share saved case',verified.caseKey===first.caseKey&&(await observed.nativeViews.reportStore.events(first.caseKey)).some(event=>event.payload.kind==='fix'));
      await observed.nativeViews.openCase(first.id);
      check('native durable case report',(await observed.nativeViews.caseText(first.caseKey)).includes('所选测试失败')&&(await observed.nativeViews.caseText(first.caseKey)).includes('所选测试通过'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('dshPanel.bridge.remove',verified.id);
    }finally{panelApi.window.showQuickPick=pick;panelApi.window.showInformationMessage=info;}
    const currentDocument=await vscode.workspace.openTextDocument(document.uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(currentDocument.uri, new vscode.Position(0,0), '// changed\\n');
    await vscode.workspace.applyEdit(edit); await currentDocument.save();
    const deadline = Date.now()+2000;
    while(vscode.languages.getDiagnostics(document.uri).length && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
    check('stale diagnostics removed', vscode.languages.getDiagnostics(document.uri).length === 0);
    const rerun=await vscode.commands.executeCommand('dshPanel.bridge.retry',first.id);
    check('explicit retry new identity',rerun&&rerun.id!==first.id&&rerun.fingerprint!==first.fingerprint);
    await vscode.commands.executeCommand('dshPanel.bridge.remove',first.id);
    check('cleanup preserves referenced case and newer findings',observed.nativeViews.operations.has(first.id)&&vscode.languages.getDiagnostics(document.uri).length===1);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('dshPanel.bridge.remove',rerun.id);
    const savedKey=first.savedKey;
    await observed.nativeViews.openCase(first.id);
    const removed=await vscode.commands.executeCommand('dshPanel.bridge.clearFinished');
    fs.writeFileSync(${JSON.stringify(path.join(folder, 'editor-cleanup-check.json'))},JSON.stringify({removed,records:[...observed.nativeViews.operations.values()].map(op=>({id:op.id,cwd:op.cwd,caseKey:op.caseKey})),diagnostics:vscode.languages.getDiagnostics(document.uri).map(item=>({source:item.source,message:item.message})),pins:[...observed.nativeViews.reportStore.pins.keys()]}));
    check('finished cleanup protects open evidence',removed===0&&observed.nativeViews.operations.has(first.id)&&vscode.languages.getDiagnostics(document.uri).length===0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    void api.review({cwd:${JSON.stringify(cwd)},input:{mode:'worktree'},userInitiated:true}).catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,1500));
    fs.writeFileSync(${JSON.stringify(closingFile)},JSON.stringify({checks,vscode:vscode.version,savedKey}));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  } catch(error) { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({status:'failed',checks,error:String(error.stack||error)})); }
};
`);
  assert(fs.existsSync(code), '找不到 VS Code');
  const isolation = isolatedEditorOptions({ userData, extensions, sharedData, env: { ...process.env, DSH_HOME: runtimeHome, DSH_PANEL_AUTOFOCUS: '0' } });
  const diagnosticLaunchFlags = process.env.DSH_PANEL_EDITOR_NO_SANDBOX === '1' ? ['--no-sandbox'] : process.env.DSH_PANEL_EDITOR_DISABLE_GPU === '1' ? ['--disable-gpu'] : [];
  const launch = () => {
    const child = spawn(code, [...isolation.args, '--new-window', '--verbose', '--disable-workspace-trust', ...diagnosticLaunchFlags, cwd, path.join(cwd, 'sample.js')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: isolation.env });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(folder, 'editor-launch.log'), redact(bytes.toString())));
    child.on('exit', (exitCode, signal) => fs.appendFileSync(path.join(folder, 'editor-launch.log'), `\nexit=${exitCode} signal=${signal}\n`));
    return child;
  };
  let child = launch(), reopened = false;
  try {
    const deadline = Date.now() + 150000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) {
      if (child.exitCode !== null && !fs.existsSync(closingFile) && !fs.existsSync(resultFile)) throw new Error(`编辑器在验收激活前退出：${child.exitCode}；启动日志：${path.join(folder, 'editor-launch.log')}`);
      if (!reopened && fs.existsSync(closingFile) && child.exitCode !== null) { child = launch(); reopened = true; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(fs.existsSync(resultFile), `编辑器验收超时：${userData}；最后检查：${fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8') : '尚未激活'}`);
    const result = JSON.parse(fs.readFileSync(resultFile)); assert.equal(result.status, 'passed', redact(result.error || ''));
    if (Number(result.vscode.split('.')[1]) >= 140) assert(fs.existsSync(path.join(sharedData, 'sharedStorage/state.vscdb')), '编辑器未使用隔离的共享账号目录');
    assert.equal(sha256(vsix), candidateSha256, '编辑器验收期间候选 VSIX 已变化');
    return { ...result, editorContext, diagnosticLaunchFlags, runtimeFilesInstrumented: ['src/extension.js', 'src/bridge/views.js'], observationOnlyInIsolation: true,
      accountStorageIsolation: { sharedData: path.relative(folder, sharedData), authenticationProvidersDisabled: true }, vsixSha256: sha256(vsix) };
  } finally {
    if (process.platform === 'win32') {
      // 重开窗口可能通过原实例转发，启动器 PID 已退出；仅清理本次隔离 user-data-dir 的实际实例。
      const processes = () => {
        const output = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
          `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`],
          { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        const rows = JSON.parse(output.trim() || '[]');
        return Array.isArray(rows) ? rows : [rows];
      };
      for (const item of editorProcessRoots(processes(), userData)) {
        try { execFileSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch (error) {
          if (processes().some(current => current.ProcessId === item.ProcessId && ownsEditorProcess(current.CommandLine, userData))) throw error;
        }
      }
    } else if (child.exitCode === null) child.kill();
  }
}
module.exports = { checkEditor, editorHomeCheck };
