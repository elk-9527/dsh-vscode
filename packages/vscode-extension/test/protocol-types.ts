import { validWebviewMessage } from '../src/panel/protocol';
import type { BridgeInvokeRequest, BridgeInvokeResult, QueueEntry } from '../src/panel/protocol-types';
declare const wire: unknown;
if (validWebviewMessage(wire)) { const type: string = wire.type; void type; }
const request: BridgeInvokeRequest = { requestId: 'one', capabilityId: 'review', input: {}, context: { cwd: '/fixture', userInitiated: true, workspaceTrusted: true } };
const response: BridgeInvokeResult = { mode: 'operation', operationId: 'operation-one' };
// @ts-expect-error operation responses always identify the accepted execution
const missingOperation: BridgeInvokeResult = { mode: 'operation' };
// @ts-expect-error unknown outcomes cannot be automatically retried
const invalidPhase: QueueEntry['phase'] = 'retry';
void [request, response, missingOperation, invalidPhase];
