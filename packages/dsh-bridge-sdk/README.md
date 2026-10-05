# DSH IDE Bridge SDK

Provider registration, TypeScript contracts, JSON Schema subset validation and an offline contract host for Bridge v1. Requires Node.js 18 or later and a DSH Door providing the Cordis `ideBridge` service.

```js
const { registerProvider } = require('dsh-ide-bridge-sdk');
exports.inject = ['ideBridge'];
exports.apply = ctx => registerProvider(ctx, {
  id: 'example.echo', name: 'Echo', version: '0.1.0',
  capabilities: [{ id: 'example.echo.read', title: 'Echo', kind: 'resource',
    riskTier: 'read', effects: [], inputSchema: { type: 'object',
      properties: { text: { type: 'string', maxLength: 128 } }, required: ['text'], additionalProperties: false } }],
  invoke: (_id, input) => ({ text: input.text }),
});
```

The host supplies the working directory, trust state, optional session/Agent, abort signal and event emitter. Providers must honor cancellation and accurately declare their effects and risk tier. Registration returns a lifecycle disposer; do not retain host contexts after unloading.

`defineProvider` checks descriptors and inputs and JSON-encodes outputs. An optional `outputSchema` validates the returned value. Supported rules are `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `maxLength`, `maxItems`, `minimum`, `maximum` and `description`. Unknown rules, excessive nesting, invalid JSON and values exceeding 1 MiB are rejected.

`createMockHost()` supports `registerProvider`, `catalog` and `invoke`. It verifies declared trust, explicit invocation and write confirmation boundaries; it does not simulate authentication, leases or operation recovery. Run `npm test` for the SDK contracts, then validate providers against a real Bridge. The installable read-only example is in `examples/echo`.

The SDK does not expose ACP sockets, bootstrap credentials or process ownership. It does not convert existing desktop plugins into providers automatically.

## File skill helper

`dsh-ide-bridge-sdk/skill-files` exports `SkillFileStore`. Supply explicit allowed roots; preview returns a diff plan bound to the Bridge-provided client ID and directory. Commit requires the same client, workspace trust, explicit invocation and approval. Plans expire after ten minutes. Writes reject links and changed source hashes, use temporary files, retain previous bodies in a sibling `.trash`, and verify the saved content. Create and restore never overwrite an existing file. This helper requires Door 0.2.1 or later to supply the authenticated client ID. It supports SKILL.md bodies up to 128 KiB.

The Skill Explorer adapter resolves actual scanned origins before preview and commit. Providers remain responsible for identifying read-only sources and selecting their roots. The helper is not a general file-writing API. Recovery uses this adapter's metadata and SHA-256-checked backups; existing unindexed upstream trash files are not treated as verified recovery records.

## Candidate validation

Version 0.1.0 is a release candidate until registry publication completes. To test the repository without a registry release, pack this package and the example, then install both archives into an isolated DSH profile. With pnpm 11, set that profile's `pnpm-workspace.yaml` override for `dsh-ide-bridge-sdk` to the exact SDK archive, so the example's fixed dependency resolves locally. The repository helper `tools/bridge/packages.cjs` supplies this override and `tools/bridge/test-live.cjs` installs the standalone example and validates it through a real Bridge alongside both pilot providers.

Run `npm test` in this package, `node tools/bridge/test-live.cjs --editor` from the repository root and the TypeScript consumer fixture before publishing. Do not substitute mock-host results for transport authentication or editor verification.
