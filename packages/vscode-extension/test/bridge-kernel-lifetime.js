'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { DshConnectionService } = require('../src/connection/service');
const { KernelManager } = require('../src/panel/kernel-manager');
const { PublicApi } = require('../src/api/service');
const { OperationStore, ACTIVE, TERMINAL } = require('../src/bridge/operations');
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'vscode' ? {} : originalLoad.call(this, request, ...args); };
const { BridgeViews } = require('../src/bridge/views'); Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const { IdeBridge } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/bridge/runtime.js')));
  const { managedLifetime } = await import(pathToFileURL(path.resolve(__dirname, '../../dsh-door/lib/bridge/managed-lifetime.js')));
  const fixtures = path.resolve(__dirname, '../../../build/test-bridge-kernel'); fs.mkdirSync(fixtures, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(fixtures, 'lifetime-'));
  try {
    // VS Code awaits deactivate's returned Promise before ending the host.
    let completeCleanup, disposeOptions, deactivated = false;
    const pendingCleanup = new Promise(resolve => { completeCleanup = resolve; });
    const closingManager = { disposeAll(_reason, options) { disposeOptions = options; return 1; }, waitForCleanup: () => pendingCleanup };
    const extensionPath = require.resolve('../src/extension'), cachedExtension = require.cache[extensionPath];
    let deactivate;
    try {
      delete require.cache[extensionPath];
      Module._load = function(request, parent, ...rest) {
        if (request === 'vscode') return {};
        if (parent?.filename === extensionPath && request === './panel/kernel-manager') return { kernelManager: () => closingManager };
        return originalLoad.call(this, request, parent, ...rest);
      };
      ({ deactivate } = require(extensionPath));
    } finally {
      Module._load = originalLoad;
      if (cachedExtension) require.cache[extensionPath] = cachedExtension; else delete require.cache[extensionPath];
    }
    const shutdown = deactivate();
    assert(shutdown instanceof Promise, 'Extension deactivation must expose pending owned-kernel cleanup to the host');
    void shutdown.then(() => { deactivated = true; }); await tick();
    assert.equal(deactivated, false, 'The host must not finish deactivation while idle-kernel termination is pending');
    assert.deepEqual(disposeOptions, { preserveBridgeRuns: true });
    completeCleanup(); await shutdown; assert.equal(deactivated, true);

    let finishIdle, idleStops = 0, activeStops = 0;
    const idleCleanup = new Promise(resolve => { finishIdle = resolve; });
    const closing = new KernelManager({ spawn: ({ port }) => ({ child: { exitCode: null, signalCode: null }, dispose() {
      if (port === 49235) { idleStops++; return idleCleanup; }
      activeStops++; return new Promise(() => {});
    } }) });
    closing.spawn({ host: '127.0.0.1', port: 49235 });
    const activeEntry = closing.spawn({ host: '127.0.0.1', port: 49236 }); activeEntry.activeBridgeRuns.add('still-executing');
    assert.equal(closing.disposeAll('window', { preserveBridgeRuns: true }), 1, 'disposeAll retains its synchronous count');
    assert.equal(idleStops, 1); assert.equal(activeStops, 0);
    let idleFinished = false; const idleWait = closing.waitForCleanup().then(() => { idleFinished = true; }); await tick();
    assert.equal(idleFinished, false, 'Manager tracks cleanup after its entry is removed');
    finishIdle(); await idleWait; assert.equal(idleFinished, true); assert.equal(activeStops, 0);

    for (const mode of ['provider-unload', 'runtime-dispose']) {
      let killed = 0, endpointDisposed = 0, complete, signal, actualDone = false;
      const kernels = new KernelManager({ idleMs: 0, spawn: () => {
        const child = new EventEmitter(); child.exitCode = child.signalCode = null;
        return { child, dispose() { killed++; assert(actualDone, 'Owned kernel termination must follow actual provider completion'); child.exitCode = 0; child.emit('exit'); } };
      } });
      const entry = kernels.spawn({ host: '127.0.0.1', port: 49234 });
      const connections = new DshConnectionService(); connections.key = entry.key;
      connections.client = Object.assign(new EventEmitter(), { isConnected: true, close() {} }); connections.status = { instanceId: 'fixture' };
      connections.bindKernels(kernels, () => kernels.live('127.0.0.1', 49234));
      const panel = { kernels, config: () => ({ host: '127.0.0.1', selfStartPort: 49234 }), wantedPreset() {} };
      const views = Object.assign(Object.create(BridgeViews.prototype), { operations: new OperationStore(), retained: new Map(), connections, panel, disposed: false });
      const events = [];
      connections.on('operation', event => {
        events.push(event);
        if (!views.operations.event(event)) return;
        const operation = views.operations.get(event.operationId);
        if (ACTIVE.has(operation.status)) views.retain(operation.id);
        if (TERMINAL.has(operation.status)) views.release(operation.id);
      });
      const runtime = new IdeBridge({ endpoint: { dispose() { endpointDisposed++; } } });
      const state = { bridgeOwner: 'fixture', bridgeLease: Infinity, respond(frame) { if (frame.method?.endsWith('/event')) connections.emit('operation', frame.params); } };
      runtime.connections.add(state);
      const unload = runtime.registerProvider({ id: 'fixture', name: 'Fixture', version: '1', capabilities: [
        { id: 'fixture.work', title: 'Work', kind: 'action', riskTier: 'read', effects: [], supportsCancellation: true },
      ], invoke(_id, _input, context) {
        signal = context.signal;
        return new Promise(resolve => { complete = value => { actualDone = true; resolve(value); }; });
      } });
      connections.bridge = { supported: true, dispose() {}, catalog: async () => runtime.catalog(), request: (method, params, options) => { options?.beforeSend?.(); return runtime.request(method, params, state); } };
      const api = new PublicApi({ vscode: { Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true, getWorkspaceFolder: () => ({}) } },
        context: { subscriptions: [] }, connections, panel, views });
      let disposal;
      try {
        const run = await api.exports.invokeCapability({ cwd, capabilityId: 'fixture.work' }); await tick();
        assert(kernels.live('127.0.0.1', 49234)); assert.equal(entry.activeBridgeRuns.has(run.operationId), true);
        if (mode === 'provider-unload') unload(); else disposal = runtime.dispose();
        await tick(); assert.equal(signal.aborted, true);
        assert.equal(killed, 0, `${mode}: releasing a visible result must not terminate a still-running provider`);
        assert.equal(endpointDisposed, 0, 'Runtime endpoint cleanup waits for actual provider completion');
        assert.equal(runtime.activeCount(), 1);
        assert.equal(events.some(event => TERMINAL.has(event.type)), false, 'An uncooperative provider has not reached a terminal execution state');
        complete({ late: true }); if (disposal) await disposal; await tick();
        assert.equal(killed, 1); assert.equal(runtime.activeCount(), 0);
        const terminal = events.filter(event => TERMINAL.has(event.type)); assert.equal(terminal.length, 1); assert.equal(terminal[0].type, 'failed');
      } finally {
        complete?.({ cleanup: true }); await runtime.dispose(); api.dispose(); connections.dispose();
      }
    }
    const previousIdle = process.env.DSH_BRIDGE_OWNED_IDLE_MS; process.env.DSH_BRIDGE_OWNED_IDLE_MS = '1000';
    let active = 1, exited = 0;
    const lifetime = managedLifetime({ bridge: { activeCount: () => active }, live: new Set(), exit: () => exited++ });
    try {
      lifetime.schedule(5); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(exited, 0, 'Server idle management also preserves active providers after disconnect');
      active = 0; lifetime.schedule(5); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(exited, 1);
    } finally { lifetime.dispose(); if (previousIdle === undefined) delete process.env.DSH_BRIDGE_OWNED_IDLE_MS; else process.env.DSH_BRIDGE_OWNED_IDLE_MS = previousIdle; }
    console.log('Bridge/kernel lifetime: API and view consumers retain zero-idle owned kernels through ignored cancellation; terminal events and endpoint cleanup follow actual settlement');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
