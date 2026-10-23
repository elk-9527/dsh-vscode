'use strict';
/** 保存匹配当前源码和最终安装包的证据，完整支持仍需最低编辑器验收。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const { ROOT,argsOf,json,sourceState,versions,sha256,safeObject }=require('../compat/lib.cjs');
function record(options) {
  const bridge=json(path.resolve(options.bridge)),real=json(path.resolve(options.real)),install=json(path.resolve(options.install));
  const state=sourceState(),current=versions();
  for(const report of [bridge,real,install]) {
    assert.equal(report.status,'passed');
    assert.deepEqual(require('../compat/release-check.cjs').validateIdentity(report,current,state,process.platform),[],'证据身份或验收起止指纹无效');
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
    assert.equal(minimum.status,'passed');
    assert.deepEqual(require('../compat/release-check.cjs').validateIdentity(minimum,current,state,process.platform),[]);
    const editor=minimum.stages.find(item=>item.name==='packed-vsix-native-editor')?.result;
    assert.equal(editor?.vscode,current.vscode.replace(/^\^/,'')); assert.equal(editor.vsixSha256,artifacts.find(item=>item.kind==='vsix').sha256);
  }
  const minimumEditor=minimum?.stages.find(item=>item.name==='packed-vsix-native-editor')?.result;
  const limitations=[];
  if(!minimumEditor) limitations.push('最低编辑器版本未验收，不能登记完整支持。');
  if(minimumEditor?.diagnosticLaunchFlags?.length) limitations.push('最低编辑器使用了诊断启动参数，默认启动尚未通过。');
  if(minimumEditor?.nativeMode==='restricted') limitations.push('最低编辑器的原生审查身份核对未通过。');
  const evidence={schemaVersion:2,time:new Date().toISOString(),platform:process.platform,source:state,sourceStart:state,sourceEnd:state,packages:current,status:limitations.length?'partial':'passed',scope:'bridge',releaseReady:false,artifacts,bridge,real,
    ...(minimum ? {minimum,limitations} : {}),
    installRecord:path.relative(ROOT,path.resolve(options.install)).replace(/\\/g,'/')};
  const file=path.join(ROOT,`compat/evidence/bridge-v2-${process.platform}-door-${current.door}-panel-${current.panel}-sdk-${current.sdk}.json`);
  assert(!fs.existsSync(file),'已登记的历史证据不可覆盖');
  const local=path.join(ROOT,'.local/compat',`${Date.now()}-bridge-record.json`);fs.mkdirSync(path.dirname(local),{recursive:true});
  fs.writeFileSync(local,JSON.stringify(safeObject(evidence),null,2)+'\n');
  const publicEvidence=require('../compat/public-evidence.cjs').publicEvidence;
  const summary={...publicEvidence(evidence),scope:'bridge',releaseReady:false,bridge:publicEvidence(bridge),real:publicEvidence(real),...(minimum?{minimum:publicEvidence(minimum)}:{})};
  fs.writeFileSync(file,JSON.stringify(summary,null,2)+'\n'); console.log(file);
}
if(require.main===module) { try { record(argsOf()); } catch(error) { console.error(error.message);process.exitCode=1; } }
module.exports={record};
