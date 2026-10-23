'use strict';
/** 拒绝测试触及日常账号目录，包括路径别名与便携模式覆盖。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isolatedEditorOptions, ownsEditorProcess, belongsToEditor, isDshKernelLauncher, editorProcessRoots } = require('../tools/editor-isolation.cjs');
const { fixtureImages, isBuildEditor, prepareEditorFixture } = require('../../../tools/bridge/editor-fixture.cjs');
const build = path.resolve(__dirname, '../../../build'); fs.mkdirSync(build, { recursive: true });
const root = fs.mkdtempSync(path.join(build, 'dsh-account-isolation-'));
const options = { userData: path.join(root, 'user'), extensions: path.join(root, 'extensions'), sharedData: path.join(root, 'shared') };
const alias = path.join(root, 'alias');
try {
  const portable = isolatedEditorOptions({ ...options, env: { APPDATA: process.env.APPDATA, VSCODE_PORTABLE: path.join(os.homedir(), '.vscode'), ELECTRON_RUN_AS_NODE: '1', DSH_PANEL_AUTOFOCUS: '1' } });
  assert(!('VSCODE_PORTABLE' in portable.env)); assert(!('ELECTRON_RUN_AS_NODE' in portable.env)); assert.equal(portable.env.DSH_PANEL_AUTOFOCUS, '1');
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: path.join(os.homedir(), '.vscode-shared') }), /日常数据/);
  assert.throws(() => isolatedEditorOptions({ ...options, userData: os.homedir() }), /日常数据/);
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: path.join(options.userData, 'shared') }), /独立/);
  assert(ownsEditorProcess('Code.exe --user-data-dir="' + options.userData + '" --verbose', options.userData));
  assert(ownsEditorProcess('Code.exe --user-data-dir=' + options.userData, options.userData));
  assert(!ownsEditorProcess('Code.exe --user-data-dir="' + options.userData + '-another"', options.userData));
  assert(!ownsEditorProcess('Code.exe --user-data-dir="' + path.join(os.homedir(), '.vscode') + '"', options.userData));
  const processes = [{ pid: 1, ppid: 0, name: 'Code.exe', cmdline: 'Code.exe --user-data-dir="' + options.userData + '"' },
    { pid: 2, ppid: 1, name: 'node.exe' }, { pid: 3, ppid: 2, name: 'cmd.exe' },
    { pid: 4, ppid: 0, name: 'Code.exe', cmdline: 'Code.exe --user-data-dir="' + options.userData + '-another"' }, { pid: 5, ppid: 4, name: 'cmd.exe' }];
  assert(belongsToEditor(processes[2], processes, options.userData)); assert(!belongsToEditor(processes[4], processes, options.userData));
  const desktop = 'C:\\Program Files\\DeepSeek Fixture\\DeepSeek Harness.exe';
  const cli = path.win32.join(path.win32.dirname(desktop), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  const proxy = 'C:\\Extension Fixture\\src\\door\\desktop-cli-host.cjs';
  const launch = values => 'C:\\Windows\\System32\\cmd.exe /d /s /c "' + values.map(value => '"' + value + '"').join(' ') + '"';
  const officialArgs = ['node.exe', proxy, desktop, cli, '--profile', 'fixture', '--no-open', '--port', '0'];
  const officialCommand = launch(officialArgs);
  assert(isDshKernelLauncher({ name: 'cmd.exe', cmdline: officialCommand }));
  assert(isDshKernelLauncher({ name: 'cmd.exe', cmdline: 'cmd.exe /d /s /c "dsh --profile fixture --no-open"' }));
  assert(isDshKernelLauncher({ name: 'cmd.exe', cmdline: launch(['C:\\DSH Fixture\\dsh.cmd', '--profile', 'fixture', '--no-open']) }));
  assert(isDshKernelLauncher({ name: 'cmd.exe', cmdline: launch(['node.exe', 'C:\\DSH Fixture\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', '--profile', 'fixture', '--no-open']) }));
  for (const bad of [launch(['echo', ...officialArgs]), launch(['node.exe', '-e', officialArgs.join(' ')]),
    launch(officialArgs.map(value => value === cli ? cli.replace('DeepSeek Fixture', 'Other Install') : value)),
    launch(officialArgs.map(value => value === proxy ? proxy.replace('desktop-cli-host', 'other-host') : value)),
    launch(officialArgs.map(value => value === '--no-open' ? '--no-open-extra' : value)),
    launch(['node.exe', proxy, desktop, cli, '--', '--profile', 'fixture', '--no-open']),
    launch(['node.exe', proxy, desktop, cli, '--profile', '--no-open']), officialCommand + ' & echo other']) {
    assert(!isDshKernelLauncher({ name: 'cmd.exe', cmdline: bad }), bad);
  }
  assert(!isDshKernelLauncher({ name: 'powershell.exe', cmdline: officialCommand }));
  assert(!isDshKernelLauncher({ name: 'node.exe', cmdline: officialCommand }));
  const processBoundary = [...processes, { pid: 6, ppid: 1, name: 'cmd.exe', cmdline: officialCommand },
    { pid: 7, ppid: 4, name: 'cmd.exe', cmdline: officialCommand }, { pid: 8, ppid: 1, name: 'cmd.exe', cmdline: officialCommand }];
  const existing = new Set([8]);
  assert.deepEqual(processBoundary.filter(item => !existing.has(item.pid) && isDshKernelLauncher(item)
    && belongsToEditor(item, processBoundary, options.userData)).map(item => item.pid), [6]);
  if (process.platform === 'win32') {
    const fixtureHost = path.join(root, 'launcher fixture/src/door/desktop-cli-host.cjs');
    fs.mkdirSync(path.dirname(fixtureHost), { recursive: true });
    fs.writeFileSync(fixtureHost, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));\n');
    const actualArgs = [process.execPath, fixtureHost, desktop, cli, '--profile', 'fixture', '--no-open'];
    const command = '"' + actualArgs.map(value => '"' + value + '"').join(' ') + '"';
    const shell = process.env.ComSpec || 'cmd.exe';
    const actual = spawnSync(shell, ['/d', '/s', '/c', command], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 });
    assert.equal(actual.status, 0, actual.stderr); assert.deepEqual(JSON.parse(actual.stdout), actualArgs.slice(1));
    assert(isDshKernelLauncher({ name: 'cmd.exe', cmdline: '"' + shell + '" /d /s /c ' + command }));
  }
  const ownedCommand = 'Code.exe --user-data-dir="' + options.userData + '"';
  const tree = [
    { ProcessId: 10, ParentProcessId: 0, CommandLine: ownedCommand },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: ownedCommand + ' --type=utility' },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: ownedCommand + ' --type=renderer' },
    { ProcessId: 20, ParentProcessId: 0, CommandLine: ownedCommand.replace(options.userData, options.userData + '-another') },
    { ProcessId: 21, ParentProcessId: 20, CommandLine: 'Code.exe --type=utility' },
    { ProcessId: 30, ParentProcessId: 999, CommandLine: ownedCommand },
  ];
  assert.deepEqual(editorProcessRoots(tree, options.userData).map(item => item.ProcessId), [10, 30]);
  assert.deepEqual(editorProcessRoots(tree.filter(item => item.ProcessId !== 10), options.userData).map(item => item.ProcessId), [11, 30]);
  assert.deepEqual(editorProcessRoots(tree.filter(item => item.ProcessId >= 20 && item.ProcessId < 30), options.userData), []);
  const fixtureAppData = path.join(root, 'appdata'), fixtureCode = path.join(fixtureAppData, 'Code'); fs.mkdirSync(fixtureCode, { recursive: true });
  fs.symlinkSync(fixtureCode, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => isolatedEditorOptions({ ...options, sharedData: alias, env: { APPDATA: fixtureAppData } }), /日常数据/);
  fs.unlinkSync(alias);
  const fixtureRoot = path.join(root, 'fixture-project'), fixtureBuild = path.join(fixtureRoot, 'build');
  const official = path.join(fixtureBuild, 'official'), daily = path.join(fixtureRoot, 'daily');
  fs.mkdirSync(official, { recursive: true }); fs.mkdirSync(daily);
  const generatedCode = path.join(official, 'Code.exe'), dailyCode = path.join(daily, 'Code.exe');
  fs.writeFileSync(generatedCode, 'fixture'); fs.writeFileSync(dailyCode, 'daily');
  fs.writeFileSync(path.join(official, 'ffmpeg.dll'), 'fixture dll'); fs.writeFileSync(path.join(official, 'unknown.dll'), 'unknown image');
  assert.deepEqual(fixtureImages(generatedCode, fixtureRoot).map(file => path.basename(file)), ['Code.exe', 'ffmpeg.dll']);
  assert(isBuildEditor(generatedCode, fixtureRoot)); assert(!isBuildEditor(dailyCode, fixtureRoot));
  let calls = 0;
  const run = (shell, args, options) => {
    calls++; assert.equal(path.basename(shell), 'powershell.exe'); assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert(args[3].includes('/setintegritylevel M')); assert(args[3].includes('Get-AuthenticodeSignature'));
    assert(args[3].includes('Get-FileHash')); assert(args[3].includes('Get-Acl')); assert(!args[3].includes('/grant')); assert(!args[3].includes('/T'));
    assert(!Object.keys(options.env).some(key => /^PSModulePath$/i.test(key)));
    return JSON.stringify(['Code.exe', 'ffmpeg.dll'].map((name, index) => ({ name, sha256: 'a'.repeat(64), sha256After: 'a'.repeat(64),
      signature: 'Valid', signatureAfter: 'Valid', dacl: 'D:fixture', daclAfter: 'D:fixture',
      normalized: index === 0, sha256Unchanged: true, daclUnchanged: true })));
  };
  const preparedFile = path.join(root, 'prepared.json');
  assert.deepEqual(prepareEditorFixture({ code: generatedCode, root: fixtureRoot, platform: 'win32', run, reportFile: preparedFile }),
    { status: 'passed', checked: 2, normalized: 1 });
  assert.equal(JSON.parse(fs.readFileSync(preparedFile)).files.length, 2); assert.equal(calls, 1);
  assert.throws(() => prepareEditorFixture({ code: dailyCode, root: fixtureRoot, platform: 'win32', run }), /build/); assert.equal(calls, 1);
  assert.throws(() => prepareEditorFixture({ code: generatedCode, root: fixtureRoot, platform: 'win32', run: () => '[]' }), /不完整/);
  assert.throws(() => prepareEditorFixture({ code: generatedCode, root: fixtureRoot, platform: 'win32', run: () => { throw new Error('invalid signature'); } }), /invalid signature/);
  assert.equal(prepareEditorFixture({ code: dailyCode, root: fixtureRoot, platform: 'linux', run }).status, 'not-applicable'); assert.equal(calls, 1);
  const fixtureAlias = path.join(fixtureBuild, 'alias'); fs.symlinkSync(daily, fixtureAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert(!isBuildEditor(path.join(fixtureAlias, 'Code.exe'), fixtureRoot));
  assert.throws(() => prepareEditorFixture({ code: path.join(fixtureAlias, 'Code.exe'), root: fixtureRoot, platform: 'win32', run }), /build/); assert.equal(calls, 1);
  fs.unlinkSync(fixtureAlias);
  const link = path.join(official, 'hardlink.exe'); fs.linkSync(generatedCode, link);
  assert.throws(() => fixtureImages(generatedCode, fixtureRoot), /链接/); fs.unlinkSync(link);
  console.log('Editor isolation rejects daily storage, overlapping paths and aliases; portable overrides removed');
} finally {
  try { fs.unlinkSync(alias); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(path.dirname(path.resolve(root)), build); assert(path.basename(root).startsWith('dsh-account-isolation-'));
  fs.rmSync(root, { recursive: true, force: true });
}
