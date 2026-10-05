'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, locate, redact, sha256 } = require('../compat/lib.cjs');
const { isolatedEditorOptions, ownsEditorProcess } = require('../../packages/vscode-extension/tools/editor-isolation.cjs');
const { probeEditorContext, requireEditorContext, installedEditor } = require('./editor-context.cjs');

async function checkEditor({ folder, cwd, port }) {
  const code = process.env.DSH_PANEL_CODE || installedEditor();
  const editorContext = probeEditorContext({ code, folder });
  if (process.env.DSH_PANEL_EXPECT_NATIVE_RESTRICTION !== '1') requireEditorContext(editorContext);
  const panelVersion = require('../../packages/vscode-extension/package.json').version;
  const vsix = path.join(ROOT, `packages/vscode-extension/build/dsh-acp-panel-${panelVersion}.vsix`);
  const extracted = path.join(folder, 'vsix');
  const quote = text => `'${text.replace(/'/g, "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(vsix)}, ${quote(extracted)})`], { windowsHide: true });
  const extensions = path.join(folder, 'editor-extensions'), userData = path.join(folder, 'editor-data'), sharedData = path.join(folder, 'editor-shared-data');
  fs.mkdirSync(extensions); fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.renameSync(path.join(extracted, 'extension'), path.join(extensions, `Elk-ydy.dsh-acp-panel-${panelVersion}`));
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
exports.activate = async () => {
  const checks = []; const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); fs.writeFileSync(${JSON.stringify(progressFile)},JSON.stringify({checks})); };
  try {
    const extension = vscode.extensions.getExtension('Elk-ydy.dsh-acp-panel');
    const api = await extension.activate(); check('extension activation', api.apiVersion === 1);
    if (fs.existsSync(${JSON.stringify(closingFile)})) {
      await api.listCapabilities();
      const deadline = Date.now()+20000;
      while(!vscode.workspace.textDocuments.some(doc=>doc.uri.scheme==='dsh-result'&&doc.getText().includes('Incorrect sum'))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
      check('window reopen restores review',vscode.workspace.textDocuments.some(doc=>doc.uri.scheme==='dsh-result'&&doc.getText().includes('Incorrect sum')));
      const previous=JSON.parse(fs.readFileSync(${JSON.stringify(closingFile)}));
      fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'passed',checks:[...previous.checks,...checks],vscode:vscode.version}));
      return;
    }
    const commands = await vscode.commands.getCommands(true);
    check('native commands', ['review','skills','refresh','cancel','openReport','diagnoseConfig','copyDiagnostics','installGuide','retry','remove','clearFinished'].every(key => commands.includes('dshPanel.bridge.'+key)));
    await vscode.commands.executeCommand('dshPanel.capabilities.focus');
    const catalog = await api.listCapabilities(); check('runtime providers', catalog.capabilities.length >= 7);
    const status = await api.getConnectionStatus(); check('one shared connection', status.connectionCount === 1);
    check('isolated endpoint home',process.env.DSH_HOME===${JSON.stringify(path.join(folder, 'home'))});
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
    await vscode.commands.executeCommand('dshPanel.bridge.copyDiagnostics');
    check('diagnosis clipboard', (await vscode.env.clipboard.readText())===diagnosis.getText());
    for(const [theme,kind] of [['Default Light Modern',1],['Default Dark Modern',2],['Default High Contrast',3]]) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      const themeDeadline=Date.now()+5000;
      while(vscode.window.activeColorTheme.kind!==kind&&Date.now()<themeDeadline) await new Promise(resolve=>setTimeout(resolve,50));
      check('native theme '+kind,vscode.window.activeColorTheme.kind===kind);
      await vscode.commands.executeCommand('dshPanel.capabilities.focus');
      await vscode.commands.executeCommand('dshPanel.operations.focus');
    }
    await vscode.commands.executeCommand('dshPanel.capabilities.focus');
    for(const action of ['list.focusDown','list.focusUp','list.expand','list.collapse']) await vscode.commands.executeCommand(action);
    check('native keyboard navigation commands',true);
    await vscode.workspace.getConfiguration('workbench').update('reduceMotion','on',vscode.ConfigurationTarget.Global);
    check('reduced motion setting',vscode.workspace.getConfiguration('workbench').get('reduceMotion')==='on');
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
    const first=await api.review({cwd:${JSON.stringify(cwd)},input:{mode:'worktree'},userInitiated:true});
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(${JSON.stringify(path.join(cwd, 'sample.js'))}));
    check('Problems finding', diagnostics.length === 1 && diagnostics[0].range.start.line === 0 && diagnostics[0].severity === vscode.DiagnosticSeverity.Warning);
    check('native full report', vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'dsh-result' && doc.getText().includes('Incorrect sum')));
    await vscode.commands.executeCommand('dshPanel.operations.focus');
    check('run view', true);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path.join(cwd, 'sample.js'))}));
    const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0,0), '// changed\\n');
    await vscode.workspace.applyEdit(edit); await document.save();
    const deadline = Date.now()+2000;
    while(vscode.languages.getDiagnostics(document.uri).length && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
    check('stale diagnostics removed', vscode.languages.getDiagnostics(document.uri).length === 0);
    const rerun=await vscode.commands.executeCommand('dshPanel.bridge.retry',first.id);
    check('explicit retry new identity',rerun&&rerun.id!==first.id&&rerun.fingerprint!==first.fingerprint);
    await vscode.commands.executeCommand('dshPanel.bridge.remove',first.id);
    check('cleanup preserves newer findings',vscode.languages.getDiagnostics(document.uri).length===1);
    const removed=await vscode.commands.executeCommand('dshPanel.bridge.clearFinished');
    check('finished cleanup',removed===1&&vscode.languages.getDiagnostics(document.uri).length===0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    void api.review({cwd:${JSON.stringify(cwd)},input:{mode:'worktree'},userInitiated:true}).catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,1500));
    fs.writeFileSync(${JSON.stringify(closingFile)},JSON.stringify({checks,vscode:vscode.version}));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  } catch(error) { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({status:'failed',checks,error:String(error.stack||error)})); }
};
`);
  assert(fs.existsSync(code), '找不到 VS Code');
  const isolation = isolatedEditorOptions({ userData, extensions, sharedData, env: { ...process.env, DSH_PANEL_AUTOFOCUS: '0' } });
  const diagnosticLaunchFlags = process.env.DSH_PANEL_EDITOR_NO_SANDBOX === '1' ? ['--no-sandbox'] : process.env.DSH_PANEL_EDITOR_DISABLE_GPU === '1' ? ['--disable-gpu'] : [];
  const launch = () => {
    const child = spawn(code, [...isolation.args, '--new-window', '--verbose', '--disable-workspace-trust', ...diagnosticLaunchFlags, cwd],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: isolation.env });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(folder, 'editor-launch.log'), redact(bytes.toString())));
    child.on('exit', (exitCode, signal) => fs.appendFileSync(path.join(folder, 'editor-launch.log'), `\nexit=${exitCode} signal=${signal}\n`));
    return child;
  };
  let child = launch(), reopened = false;
  try {
    const deadline = Date.now() + 90000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) {
      if (!reopened && fs.existsSync(closingFile) && child.exitCode !== null) { child = launch(); reopened = true; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(fs.existsSync(resultFile), `编辑器验收超时：${userData}；最后检查：${fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8') : '尚未激活'}`);
    const result = JSON.parse(fs.readFileSync(resultFile)); assert.equal(result.status, 'passed', redact(result.error || ''));
    if (!result.vscode.startsWith('1.85.')) assert(fs.existsSync(path.join(sharedData, 'sharedStorage/state.vscdb')), '编辑器未使用隔离的共享账号目录');
    return { ...result, editorContext, diagnosticLaunchFlags, accountStorageIsolation: { sharedData: path.relative(folder, sharedData), authenticationProvidersDisabled: true }, vsixSha256: sha256(vsix) };
  } finally {
    if (process.platform === 'win32') {
      // 重开窗口可能通过原实例转发，启动器 PID 已退出；仅清理本次隔离 user-data-dir 的实际实例。
      const output = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      const rows = JSON.parse(output.trim() || '[]');
      for (const item of Array.isArray(rows) ? rows : [rows]) if (ownsEditorProcess(item.CommandLine, userData)) {
        try { execFileSync('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch (error) { if (error.status !== 128) throw error; }
      }
    } else if (child.exitCode === null) child.kill();
  }
}
module.exports = { checkEditor };
