'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { editorHomeCheck, checkEditor } = require('./editor-check.cjs');
const { createFixture } = require('../test-workspace.cjs');
const { createRunResources } = require('../run-resources.cjs');

(async () => {
  const folder = createFixture('editor-home'), previous = process.env.DSH_HOME;
  const resources = createRunResources({ folder, label: 'work' });
  const legacyHome = path.join(folder, 'home'), runtimeHome = path.join(resources.work, 'home');
  fs.mkdirSync(legacyHome); fs.mkdirSync(runtimeHome);
  const execute = (source, home) => {
    const checks = [];
    vm.runInNewContext(source, { process: { env: home === undefined ? {} : { DSH_HOME: home } },
      check(name, passed) { assert.equal(name, 'isolated endpoint home'); assert(passed, 'isolated endpoint home'); checks.push(name); } });
    assert.deepEqual(checks, ['isolated endpoint home']);
  };
  try {
    // Execute the same assertion source that is inserted into the native extension host.
    for (const home of [legacyHome, runtimeHome]) {
      process.env.DSH_HOME = home;
      const source = editorHomeCheck({ folder, runtimeHome: home });
      execute(source, home);
      for (const wrong of [undefined, 'home', folder, path.dirname(home), path.join(folder + '-other', 'home')]) {
        assert.throws(() => execute(source, wrong), /isolated endpoint home/);
      }
    }
    process.env.DSH_HOME = runtimeHome;
    const source = editorHomeCheck({ folder, runtimeHome });
    assert.throws(() => execute(source, legacyHome), /isolated endpoint home/);
    assert.throws(() => execute(source, path.join(folder, 'work-other', 'home')), /isolated endpoint home/);
    assert.throws(() => editorHomeCheck({ folder, runtimeHome: legacyHome }), /DSH_HOME/);
    for (const wrong of [undefined, 'home', folder, resources.work, runtimeHome + path.sep + '.', path.join(folder, 'work-missing', 'home'), path.join(folder, 'arbitrary', 'home'), path.join(folder + '-other', 'home')]) {
      assert.throws(() => editorHomeCheck({ folder, runtimeHome: wrong }));
    }
    assert.throws(() => editorHomeCheck({ folder: path.resolve(folder, '../../..'), runtimeHome }), /build/);
    // The public native entry rejects a missing or mismatched home before inspecting a VSIX or launching an editor.
    await assert.rejects(checkEditor({ folder, runtimeHome: legacyHome }), /DSH_HOME/);
    await assert.rejects(checkEditor({ folder }), /home/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    const cleanup = await resources.close(); assert.equal(cleanup.status, 'passed'); assert.equal(cleanup.abort, undefined);
  }
  console.log('PASS native editor home: legacy/current layouts, exact generated host assertion, wrong homes and early entry rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
