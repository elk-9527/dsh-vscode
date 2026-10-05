'use strict';
/** 真实模型验收仅使用专用配置集和生成的小仓库，不向模型发送日常项目内容。 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { ROOT, resolveRuntime, locate, runDir, versions, sourceState, safeObject, redact, sha256 } = require('../compat/lib.cjs');
const { freePort, waitFor, bounded } = require('../compat/test.cjs');
const { desktopProfilePatchArgs } = require('../../packages/vscode-extension/src/door/setup');
const { DoorClient } = require('../../packages/vscode-extension/src/door/client');
const { BridgeClient } = require('../../packages/vscode-extension/src/bridge/client');
const { DshSession } = require('../../packages/vscode-extension/src/dsh/session');
const { repositorySnapshot } = require('../../packages/vscode-extension/src/bridge/results');

async function run() {
  const folder = runDir('bridge-real'), cwd = path.join(folder,'workspace'); fs.mkdirSync(cwd);
  const report = { time:new Date().toISOString(), source:sourceState(), packages:versions(), status:'failed', checks:[] };
  const check = (name,evidence) => { report.checks.push({name,status:'passed',evidence}); console.log(`PASS ${name}`); };
  let kernel,client,bridge,session,port;
  try {
    fs.writeFileSync(path.join(cwd,'sample.js'),'export function sum(a, b) { return a + b; }\n');
    for (const args of [['init','-q'],['add','sample.js'],['-c','user.name=Bridge test','-c','user.email=bridge@example.invalid','commit','-qm','baseline']]) locate.runDshSync({command:'git',args:['-C',cwd,...args]});
    fs.writeFileSync(path.join(cwd,'sample.js'),'export function sum(a, b) { return a - b; }\n');
    const before = await repositorySnapshot(cwd);
    const runtime = resolveRuntime({dsh:'0.2.0-rc.2'}), profile='bridge-real';
    const directory = path.join(process.env.DSH_HOME || path.join(os.homedir(),'.dsh'),'profiles',profile);
    if (fs.existsSync(path.join(directory,'package.json'))) {
      const backup = path.join(folder,'profile-before'); fs.mkdirSync(backup);
      for (const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.yml','cordis.patch.yml']) if(fs.existsSync(path.join(directory,name))) fs.copyFileSync(path.join(directory,name),path.join(backup,name));
    } else locate.runDshSync({command:runtime.command,args:['--profile',profile,'--from-default-profile','web','--dump-config']});
    const pilots = JSON.parse(fs.readFileSync(path.join(ROOT,'build/ide-bridge/pilots/manifest.json')));
    const candidates = [path.join(ROOT,`build/dsh-acp-door-${versions().door}.tgz`),require('./packages.cjs').packSdk(folder),...pilots.map(p=>path.join(ROOT,p.file))].map(file=>{
      const persistent=path.join(ROOT,'build/install',`${path.basename(file,'.tgz')}-${sha256(file).slice(0,16)}.tgz`);
      fs.mkdirSync(path.dirname(persistent),{recursive:true}); if(!fs.existsSync(persistent)) fs.copyFileSync(file,persistent); return persistent;
    });
    require('./packages.cjs').pinSdk(directory, candidates[1]);
    locate.runDshSync({command:runtime.command,args:['plugin','--profile',profile,'add',...candidates.map(file=>`file:${file.replace(/\\/g,'/')}`)],timeoutMs:180000});
    for(const pilot of pilots) assert.equal(sha256(path.join(directory,'node_modules',pilot.name,'lib/index.js')),sha256(path.join(ROOT,'build/ide-bridge/pilots',`${pilot.key}-${pilot.candidate}`,'lib/index.js')));
    const manifestFile = path.join(directory,'package.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
    const source = JSON.parse(fs.readFileSync(path.join(directory,'../desktop/package.json')));
    manifest.dsh.profile.bundles = [...new Set([...manifest.dsh.profile.bundles,...source.dsh.profile.bundles.filter(name=>/^@deepseek-ai\/dsh-experimental-/.test(name))])];
    fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    port = await freePort();
    kernel = locate.spawnBackgroundDsh({command:runtime.command,profile,port,extraArgs:desktopProfilePatchArgs({profile:'vscode-panel'}),
      log(level,line) { fs.appendFileSync(path.join(folder,'kernel.log'),`${level}: ${redact(line)}\n`); }});
    await waitFor(()=>locate.probePort('127.0.0.1',port),60000);
    client = new DoorClient({host:'127.0.0.1',port}); await client.connect();
    const status = await client.doorStatus(); assert.equal(status.version,versions().door); assert(status.model.ready);
    bridge = new BridgeClient({client,status,clientId:'bridge-real-validation'});
    const catalog = await bridge.catalog(); assert(catalog.capabilities.some(c=>c.id==='michengai.code-review.run'));
    check('real-runtime-catalog',{runtime:runtime.version,provider:status.model.provider,model:status.model.model,capabilities:catalog.capabilities.length});
    session = new DshSession({client}); await session.start({cwd,preset:'standard'});
    const permissions = await client.permissionGet(session.sessionId);
    if (permissions.options.some(p=>p.value==='auto')) await client.permissionSet(session.sessionId,'auto');
    const run = await bridge.request('invoke',{requestId:require('node:crypto').randomUUID(),capabilityId:'michengai.code-review.run',
      input:{mode:'worktree'},context:{cwd,sessionId:session.sessionId,userInitiated:true,workspaceTrusted:true}});
    let result;
    await bounded((async()=>{ do { result = await bridge.request('operation/get',{operationId:run.operationId});
      if(result.status!=='running') break; await new Promise(resolve=>setTimeout(resolve,1000)); } while(true); })(),180000);
    assert.equal(result.status,'completed',JSON.stringify(result.result));
    assert(Array.isArray(result.result.findings)); assert(result.result.rawText?.length>0);
    assert(result.result.findings.some(f=>f.file?.endsWith('sample.js')),'真实模型未返回示例代码的问题位置');
    fs.writeFileSync(path.join(folder,'review-report.json'),JSON.stringify(safeObject(result.result),null,2)+'\n');
    check('real-model-native-review',{findings:result.result.findings.length,structuredResult:true});
    assert.equal((await repositorySnapshot(cwd)).fingerprint,before.fingerprint); check('review-keeps-workspace',{unchanged:true});
    const health = await bridge.request('invoke',{requestId:require('node:crypto').randomUUID(),capabilityId:'linxin.skill-explorer.health',input:{},context:{cwd,workspaceTrusted:true,userInitiated:true}});
    assert.equal(health.value.ok,true); check('real-profile-skills-health',{ok:true});
    report.status='passed';
  } catch(error) { report.error=redact(error.message); console.error(report.error); process.exitCode=1; }
  finally {
    bridge?.dispose(); session?.dispose(); client?.close(); kernel?.dispose();
    if(port) { try { await waitFor(async()=>!await locate.probePort('127.0.0.1',port),10000); check('test-kernel-cleanup',{portClosed:true}); }
      catch(error) { report.status='failed'; report.cleanupError=redact(error.message); process.exitCode=1; } }
    fs.writeFileSync(path.join(folder,'real-report.json'),JSON.stringify(safeObject(report),null,2)+'\n'); console.log(path.join(folder,'real-report.json'));
  }
}
if(require.main===module) run();
