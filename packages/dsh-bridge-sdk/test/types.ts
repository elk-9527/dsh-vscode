import { defineProvider, createMockHost, registerProvider, InvokeContext } from '../lib';
import { SkillFileStore } from '../lib/skill-files';
import type { DshPanelApi } from '../../vscode-extension/src/api';
const provider = defineProvider({ id: 'typed', name: 'Typed', version: '1.0.0', capabilities: [{ id: 'typed.read', title: 'Read', kind: 'resource', riskTier: 'read', effects: [] }], invoke(_id, input, context) { context.emit({ type: 'progress', payload: { message: 'Read' } }); return input; } });
const host = createMockHost(); registerProvider({ ideBridge: host }, provider);
const context: InvokeContext = { cwd: '/workspace', clientId: 'typed', workspaceTrusted: true, userInitiated: true, approved: true, signal: new AbortController().signal, emit() {} };
const store = new SkillFileStore({ roots: ctx => ({ project: ctx.cwd + '/.dsh/skills' }) });
store.preview({ action: 'create', name: 'typed', scope: 'project', content: '---\nname: typed\n---\nBody' }, context);
async function consume(api: DshPanelApi) {
  const session = await api.createSession({ cwd: context.cwd, userInitiated: true });
  await api.prompt(session, 'Hello', { userInitiated: true, signal: context.signal, onPermission: request => request.options[0]?.optionId, onEvent: event => { if (event.type === 'text') String(event.delta); } });
  await api.openPanel(session); await api.closeSession(session);
  // @ts-expect-error Explicit invocation is mandatory for session creation.
  await api.createSession({ cwd: context.cwd });
  // @ts-expect-error The API does not expose a transport client.
  api.client;
}
void consume;
