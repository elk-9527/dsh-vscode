'use strict';
const { registerProvider } = require('dsh-ide-bridge-sdk');
exports.inject = ['ideBridge'];
exports.apply = ctx => registerProvider(ctx, {
  id: 'example.echo', name: 'Echo Example', version: '0.1.0',
  capabilities: [{ id: 'example.echo.read', title: 'Echo a value', kind: 'resource', riskTier: 'read', effects: [],
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 128 } }, required: ['text'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, outputKinds: ['echo'] }],
  invoke: (_id, input) => ({ text: input.text }),
});
