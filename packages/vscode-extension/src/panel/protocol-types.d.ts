export type RequestId = string | number;
export type { SessionHandle } from '../api/index';
export interface TextAttachmentSnapshot { readonly text: string; readonly byteLength: number; readonly kind?: string; readonly name?: string; readonly id?: string; readonly [key: string]: unknown }
export interface ImageAttachmentSnapshot { readonly kind: 'image'; readonly id: string; readonly sha256: string; readonly name: string; readonly mimeType: string; readonly byteLength: number; readonly text?: never; readonly [key: string]: unknown }
export type AttachmentSnapshot = TextAttachmentSnapshot | ImageAttachmentSnapshot;
export interface QueueEntry {
  readonly id: string; readonly requestId?: RequestId; readonly text: string;
  readonly attachments: readonly AttachmentSnapshot[]; readonly cwd: string;
  readonly sessionId: string; readonly instanceId?: string; readonly requestDigest?: string; readonly createdAt: number;
  readonly phase: 'waiting' | 'running' | 'uncertain'; readonly uncertain?: boolean; readonly restored?: boolean;
}
export interface QueueRecord { version: 1; savedAt: number; items: QueueEntry[] }
export interface BridgeInvokeRequest {
  requestId: string; capabilityId: string; input: unknown;
  context: { cwd: string; sessionId?: string; workspaceTrusted: boolean; userInitiated: boolean; approved?: boolean };
}
export type BridgeInvokeResult = { mode: 'immediate'; value: unknown } | { mode: 'operation'; operationId: string; acceptedAt?: string };
export type MessageType = 'ready' | 'send' | 'queueAction' | 'historyBack' | 'errorAction' | 'draft' |
  'composerQuery' | 'contextAdd' | 'composerSelect' | 'composerCommand' | 'workflowAction' | 'composerCancel' |
  'stop' | 'newSession' | 'setModel' | 'setOption' | 'setPreset' | 'setPermission' | 'refreshPermission' |
  'permission' | 'historyList' | 'historyOpen' | 'historyResume' | 'historyExport' | 'historyArchive' | 'openLink' | 'memeCatalog' | 'memeRead' |
  'imageAdd' | 'imagePick' | 'imagePreview' | 'imageResolve';
export type WebviewMessage = { type: MessageType; requestId?: RequestId; [key: string]: unknown };
