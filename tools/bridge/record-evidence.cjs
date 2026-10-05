'use strict';
/** 保存匹配当前源码和最终安装包的证据，完整支持仍需最低编辑器验收。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const { ROOT,argsOf,json,sourceState,versions,sha256,safeObject }=require('../compat/lib.cjs');
function record(options) {
  const bridge=json(path.resolve(options.bridge)),real=json(path.resolve(options.real)),install=json(path.resolve(options.install));
  const state=sourceState(),current=versions();
  for(const report of [bridge,real,install]) {
    assert.equal(report.status,'passed'); assert.equal(report.source.fingerprint,state.fingerprint);
  }
  assert(bridge.stages.every(item=>item.status==='passed'));
  for(const name of ['native-code-review','running-review-reconnect','packed-vsix-native-editor','owned-idle-exit']) assert(bridge.stages.some(item=>item.name===name));
  for(const name of ['real-model-native-review','review-keeps-workspace','real-profile-skills-health','test-kernel-cleanup']) assert(real.checks.some(item=>item.name===name&&item.status==='passed'));
  const artifacts=install.artifacts.map(item=>({...item,sha256:sha256(path.resolve(ROOT,item.file))}));
  for(const item of artifacts) assert.equal(item.sha256,install.artifacts.find(old=>old.file===item.file).sha256);
  assert.equal(artifacts.find(item=>item.kind==='vsix').sha256,bridge.stages.find(item=>item.name==='packed-vsix-native-editor').result.vsixSha256);
  for(const item of artifacts.filter(item=>item.kind==='tgz'||item.kind==='pilot')) assert(bridge.artifacts.some(other=>other.sha256===item.sha256));
  assert(install.operations.every(item=>item.status==='passed'));
  const minimum = typeof options.minimum === 'string' ? json(path.resolve(options.minimum)) : undefined;
  if (minimum) {
    assert.equal(minimum.status,'passed'); assert.equal(minimum.source.fingerprint,state.fingerprint);
    const editor=minimum.stages.find(item=>item.name==='packed-vsix-native-editor')?.result;
    assert(editor?.vscode?.startsWith('1.85.')); assert.equal(editor.vsixSha256,artifacts.find(item=>item.kind==='vsix').sha256);
  }
  const minimumEditor=minimum?.stages.find(item=>item.name==='packed-vsix-native-editor')?.result;
  const limitations=[];
  if(!minimumEditor) limitations.push('最低编辑器版本未验收，不能登记完整支持。');
  if(minimumEditor?.diagnosticLaunchFlags.includes('--no-sandbox')) limitations.push('VS Code 1.85.2 默认启动在本机退出；隔离诊断启动不代表默认启动已通过。');
  if(minimumEditor?.nativeMode==='restricted') limitations.push('VS Code 1.85.2 仅聊天、诊断和受限执行路径通过；原生审查的身份核对未通过。');
  const evidence={schemaVersion:1,time:new Date().toISOString(),source:state,packages:current,status:limitations.length?'partial':'passed',releaseReady:limitations.length===0,artifacts,bridge,real,
    ...(minimum ? {minimum,limitations} : {}),
    installRecord:path.relative(ROOT,path.resolve(options.install)).replace(/\\/g,'/')};
  const file=path.join(ROOT,`compat/evidence/bridge-v1-win32-door-${current.door}-panel-${current.panel}.json`);
  fs.writeFileSync(file,JSON.stringify(safeObject(evidence),null,2)+'\n'); console.log(file);
}
if(require.main===module) { try { record(argsOf()); } catch(error) { console.error(error.message);process.exitCode=1; } }
module.exports={record};
