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
  const start = sourceState();
  const report = { schemaVersion:2, time:new Date().toISOString(), source:start, sourceStart:start, platform:process.platform, packages:versions(), status:'failed', checks:[], artifacts:[] };
  const check = (name,evidence) => { report.checks.push({name,status:'passed',evidence}); console.log(`PASS ${name}`); };
  let kernel,client,bridge,session,port;
  try {
    const options = require('../compat/lib.cjs').argsOf();
    const supplied = require('./packages.cjs').candidates(options);
    report.artifacts = [supplied.tgz, supplied.sdk].map(require('./packages.cjs').artifactRecord);
    assert(process.env.DSH_HOME, '真实验收需要显式指定 build/ 下的专用 DSH_HOME');
    const testHome = path.resolve(process.env.DSH_HOME), buildRoot = path.join(ROOT, 'build');
    assert(testHome.startsWith(buildRoot + path.sep) && testHome !== buildRoot, '真实验收 DSH_HOME 必须位于本项目 build/ 专用子目录');
    fs.mkdirSync(testHome, { recursive: true });
    assert(fs.realpathSync(testHome).startsWith(fs.realpathSync(buildRoot) + path.sep), '真实验收 DSH_HOME 不能通过链接指向日常配置');
    const header = '/** Add two finite numeric inputs. */\n';
    // 新导出和测试在基线之后加入，成功修复仍保留待审查差异。
    fs.writeFileSync(path.join(cwd,'sample.js'),'export {};\n');
    fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({private:true,type:'module',scripts:{test:'node --test sum.test.js'}})+'\n');
    fs.mkdirSync(path.join(cwd,'.vscode'));
    fs.writeFileSync(path.join(cwd,'.vscode/tasks.json'),JSON.stringify({version:'2.0.0',tasks:[{label:'fixture regression',type:'process',command:'node',args:['--test','sum.test.js'],group:'test'}]})+'\n');
    for (const args of [['init','-q'],['add','.'],['-c','user.name=Bridge test','-c','user.email=bridge@example.invalid','commit','-qm','baseline']]) locate.runDshSync({command:'git',args:['-C',cwd,...args]});
    fs.writeFileSync(path.join(cwd,'sample.js'),header+'export function sum(a, b) { return a - b; }\n');
    fs.writeFileSync(path.join(cwd,'sum.test.js'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sample.js';\ntest('adds numeric inputs', () => { assert.equal(sum(2, 3), 5); assert.equal(sum(-4, 7), 3); assert.equal(sum(0, 1), 1); });\n");
    const before = await repositorySnapshot(cwd);
    const runtime = resolveRuntime({dsh:process.env.DSH_PANEL_TEST_DSH_VERSION, command:process.env.DSH_PANEL_DSH}), profile='bridge-real';
    const directory = path.join(process.env.DSH_HOME || path.join(os.homedir(),'.dsh'),'profiles',profile);
    if (fs.existsSync(path.join(directory,'package.json'))) {
      const backup = path.join(folder,'profile-before'); fs.mkdirSync(backup);
      for (const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.yml','cordis.patch.yml']) if(fs.existsSync(path.join(directory,name))) fs.copyFileSync(path.join(directory,name),path.join(backup,name));
    } else locate.runDshSync({command:runtime.command,args:['--profile',profile,'--from-default-profile','web','--dump-config']});
    const pilots = JSON.parse(fs.readFileSync(path.join(ROOT,'build/ide-bridge/pilots/manifest.json')));
    const candidates = [supplied.tgz.file,supplied.sdk.file,...pilots.map(p=>path.join(ROOT,p.file))].map(file=>{
      const persistent=path.join(ROOT,'build/install',`${path.basename(file,'.tgz')}-${sha256(file).slice(0,16)}.tgz`);
      fs.mkdirSync(path.dirname(persistent),{recursive:true}); if(!fs.existsSync(persistent)) fs.copyFileSync(file,persistent); return persistent;
    });
    require('./packages.cjs').pinSdk(directory, candidates[1]);
    locate.runDshSync({command:runtime.command,args:['plugin','--profile',profile,'add',...candidates.map(file=>`file:${file.replace(/\\/g,'/')}`)],timeoutMs:180000});
    assert.deepEqual(require('../../packages/vscode-extension/test/helpers/door').inspectDoor(profile).drift,[],'Installed Door differs from current source.');
    for(const pilot of pilots) assert.equal(sha256(path.join(directory,'node_modules',pilot.name,'lib/index.js')),sha256(path.join(ROOT,'build/ide-bridge/pilots',`${pilot.key}-${pilot.candidate}`,'lib/index.js')));
    const manifestFile = path.join(directory,'package.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
    const source = JSON.parse(fs.readFileSync(path.join(directory,'../desktop/package.json')));
    manifest.dsh.profile.bundles = [...new Set([...manifest.dsh.profile.bundles,...source.dsh.profile.bundles.filter(name=>/^@deepseek-ai\/dsh-experimental-/.test(name))])];
    fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    port = await freePort();
    const startKernel = async () => {
      kernel = locate.spawnBackgroundDsh({command:runtime.command,profile,port,extraArgs:desktopProfilePatchArgs({profile:'vscode-panel'}),
        log(level,line) { fs.appendFileSync(path.join(folder,'kernel.log'),`${level}: ${redact(line)}\n`); }});
      await waitFor(()=>locate.probePort('127.0.0.1',port),60000);
      client = new DoorClient({host:'127.0.0.1',port}); await client.connect();
      const value = await client.doorStatus(); assert.equal(value.version,versions().door); assert(value.model.ready);
      return value;
    };
    let status = await startKernel();
    const provider = require('./test-profile.cjs').prepareTestProvider({profile, command:runtime.command, folder,
      packageName:process.env.DSH_PANEL_TEST_PROVIDER_PACKAGE || status.model.provider});
    if (provider.synced) {
      client.close(); await kernel.dispose();
      await waitFor(async()=>!await locate.probePort('127.0.0.1',port),10000);
      status = await startKernel();
    }
    if (provider.packageName) check('real-model-provider-installed',{package:provider.packageName,version:provider.version,digest:provider.digest});
    bridge = new BridgeClient({client,status,clientId:'bridge-real-validation'});
    const catalog = await bridge.catalog(); assert(catalog.capabilities.some(c=>c.id==='michengai.code-review.run'));
    check('real-runtime-catalog',{runtime:runtime.version,provider:status.model.provider,model:status.model.model,capabilities:catalog.capabilities.length});
    session = new DshSession({client}); await session.start({cwd,preset:'standard'});
    check('real-session-start',{created:true});
    const permissions = await client.permissionGet(session.sessionId);
    check('real-permission-catalog',{read:true});
    const selectedPermission = permissions.options.some(p=>p.value==='auto') ? 'auto' : permissions.currentValue;
    const selected = await client.permissionSet(session.sessionId,selectedPermission);
    assert.equal(selected.currentValue,selectedPermission);
    assert.equal((await client.permissionGet(session.sessionId)).currentValue,selectedPermission);
    check('real-permission-selection',{value:selectedPermission,confirmed:true});
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
    await require('./test-real-workflow.cjs').runRealWorkflow({cwd,folder,client,bridge,session,operationId:run.operationId,result:result.result,fingerprint:before.fingerprint,check});
    const health = await bridge.request('invoke',{requestId:require('node:crypto').randomUUID(),capabilityId:'linxin.skill-explorer.health',input:{},context:{cwd,workspaceTrusted:true,userInitiated:true}});
    assert.equal(health.value.ok,true); check('real-profile-skills-health',{ok:true});
    report.status='passed';
  } catch(error) { report.error=redact(error.message); console.error(report.error); process.exitCode=1; }
  finally {
    bridge?.dispose(); session?.dispose(); client?.close(); await kernel?.dispose();
    if(port) { try { await waitFor(async()=>!await locate.probePort('127.0.0.1',port),10000); check('test-kernel-cleanup',{portClosed:true}); }
      catch(error) { report.status='failed'; report.cleanupError=redact(error.message); process.exitCode=1; } }
    require('./packages.cjs').finishEvidence(report);
    fs.writeFileSync(path.join(folder,'real-report.json'),JSON.stringify(safeObject(report),null,2)+'\n'); console.log(path.join(folder,'real-report.json'));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}
if(require.main===module) run();
