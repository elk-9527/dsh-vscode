# Extension API v1, revision 2

Other VS Code extensions can depend on `Elk-ydy.dsh-acp-panel` and call `activate()` to obtain the API. Feature-detect `apiRevision` or `features`; revision 2 retains the original catalog, connection status and review methods. Type declarations ship at `src/api/index.d.ts`.

```js
const extension = vscode.extensions.getExtension('Elk-ydy.dsh-acp-panel');
if (!extension) throw new Error('DSH ACP Panel is required');
const api = await extension.activate();
if (!api.features?.includes('prompt-stream')) throw new Error('Update DSH ACP Panel');
const session = await api.createSession({ cwd, userInitiated: true });
const abort = new AbortController();
try {
  await api.prompt(session, 'Explain this project', {
    userInitiated: true, signal: abort.signal,
    onEvent(event) { if (event.type === 'text') output.append(event.delta); },
    // No permission callback means the tool request is declined.
  });
} finally {
  await api.closeSession(session);
}
```

Session handles contain opaque IDs, workspace directory, DSH session ID, preset and kernel instance ID. They contain no socket, endpoint record, bootstrap secret or lease. The API uses the panel's DSH configuration and shares its connection. Directory arguments must refer to existing folders within the current VS Code workspace. Session execution requires workspace trust and explicit invocation. Handle IDs are valid for the current extension activation; persist the DSH session metadata and call `restoreSession` after a window reload.

| Method | Behavior |
| --- | --- |
| `listCapabilities()` | Read the registered Bridge catalog. |
| `getConnectionStatus()` | Read connection metadata; the owning profile may be unknown. |
| `createSession({cwd,preset?,userInitiated:true})` | Create a DSH session. |
| `restoreSession({cwd,sessionId,preset?,userInitiated:true})` | Resume DSH history using a new handle. |
| `getPanelSession()` | Obtain a handle for the current panel session. |
| `prompt(handle,text,options)` | Stream text, thinking, tool, usage and done events; resolve with the stop reason and session metadata. |
| `closeSession(handle)` | Release an idle handle; preserve a session currently displayed in the panel. |
| `openPanel(handle)` | Continue the same idle session in the panel within its workspace. |
| `review({cwd,input,userInitiated:true,signal?})` | Run code review using a separate session and native report presentation. |
| `invokeCapability(request)` | Return an immediate JSON value or an owned operation ID. |
| `getOperation(id)` / `cancel({kind:'operation',id})` | Query or cancel an owned operation. |
| `cancel(handle)` | Cancel the current prompt. |

Prompts for one DSH session run in FIFO order across the panel and API. Requests for different sessions can proceed independently. `AbortSignal` cancels the intended prompt; a queued prompt cancelled before execution does not reach the model. `onPermission` can return only one of the supplied `optionId` values. Missing, invalid or cancelled answers decline the request. The caller must present the actual choices to the user and must not infer approval.

Capability requests contain `cwd`, `capabilityId`, JSON `input`, optional `session`, `userInitiated` and `approved`. Execution requires an explicit action and a trusted workspace; workspace writes and system actions additionally require approval of their effect scope. The Bridge enforces these conditions again. A generic invocation does not bypass a provider's validation or confirmation flow. Skill writes require a provider-issued preview plan before commit.

`onDidChangeConnection`, `onDidChangeCapabilities` and `onDidChangeOperation` return disposables. Operation events contain identity, sequence, type and time; query the operation for its payload. Dispose listeners and close unused sessions. The API limits active handles to 64 and prompt text to 256 KiB in UTF-8. Bridge JSON values are limited to 1 MiB. Stale handles, kernel changes and foreign operation IDs fail explicitly; restoration does not silently create a replacement conversation.

Native Chat uses this same API inside the main extension. Chat requires the stable participant API introduced in [VS Code 1.91](https://code.visualstudio.com/updates/v1_91); the panel remains available on older editors. Participation follows the [official Chat API](https://code.visualstudio.com/api/extension-guides/ai/chat) and does not select a Copilot model for DSH requests.
