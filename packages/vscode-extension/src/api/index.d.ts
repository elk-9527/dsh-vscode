export interface SessionHandle { readonly id: string; readonly cwd: string; readonly sessionId: string; readonly preset?: string; readonly instanceId?: string }
export interface SessionRequest { cwd: string; userInitiated: true; preset?: string }
export interface Disposable { dispose(): void }
export interface PromptEvent { type: 'text' | 'thinking' | 'tool' | 'usage' | 'done'; delta?: string; [key: string]: unknown }
export interface PromptOptions { userInitiated: true; signal?: AbortSignal; attachments?: object[]; onEvent?(event: PromptEvent): void; onPermission?(request: { options: Array<{ optionId: string; name: string }>; [key: string]: unknown }): Promise<string | undefined> | string | undefined }
export interface CapabilityRequest { cwd: string; capabilityId: string; input?: unknown; session?: SessionHandle; userInitiated?: boolean; approved?: boolean }
export interface DshPanelApi {
  readonly apiVersion: 1; readonly apiRevision: 2; readonly features: readonly string[];
  listCapabilities(): Promise<{ capabilities: Array<{ id: string; title: string; riskTier: string; [key: string]: unknown }> }>;
  getConnectionStatus(): Promise<{ connected: boolean; supported: boolean; authorized: boolean; state: string; connectionCount?: number; version?: string; model?: { ready: boolean; source: string; provider?: string; model?: string }; capabilities?: object; runtime?: { acpVersion: string } }>;
  review(request: SessionRequest & { input: { mode: 'worktree' | 'base' | 'commit' | 'custom'; ref?: string; instructions?: string }; signal?: AbortSignal }): Promise<unknown>;
  createSession(request: SessionRequest): Promise<SessionHandle>;
  restoreSession(request: SessionRequest & { sessionId: string }): Promise<SessionHandle>;
  getPanelSession(): Promise<SessionHandle>;
  prompt(session: SessionHandle, text: string, options: PromptOptions): Promise<{ stopReason: string; session: SessionHandle }>;
  closeSession(session: SessionHandle): Promise<boolean>;
  invokeCapability(request: CapabilityRequest): Promise<{ mode: 'immediate'; value: unknown } | { mode: 'operation'; operationId: string }>;
  getOperation(id: string): Promise<{ status: string; result?: unknown; [key: string]: unknown }>;
  cancel(target: SessionHandle | { kind: 'operation'; id: string }): Promise<unknown>;
  openPanel(session: SessionHandle): Promise<SessionHandle>;
  onDidChangeConnection(listener: (event: object) => void): Disposable;
  onDidChangeCapabilities(listener: (event: { changed: true }) => void): Disposable;
  onDidChangeOperation(listener: (event: { operationId: string; seq: number; type: string; at?: string }) => void): Disposable;
}
