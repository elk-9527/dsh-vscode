export type RiskTier = 'read' | 'execute' | 'workspace-write' | 'system';
export interface Schema { type?: 'object' | 'array' | 'string' | 'boolean' | 'integer' | 'number' | 'null'; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; maxLength?: number; maxItems?: number; minimum?: number; maximum?: number; description?: string }
export interface Capability { id: string; title: string; description?: string; kind: 'action' | 'resource' | 'workflow'; riskTier: RiskTier; effects: string[]; requiresSession?: boolean; supportsCancellation?: boolean; inputSchema?: Schema; outputSchema?: Schema; outputKinds?: string[]; availability?: { state: string; reason?: string } }
export interface InvokeContext { cwd: string; workspaceTrusted: boolean; userInitiated: boolean; approved?: boolean; clientId?: string; sessionId?: string; signal: AbortSignal; agent?: unknown; emit(event: { type: 'progress' | 'artifact'; payload: unknown }): void }
export interface Provider { id: string; name: string; version: string; capabilities: Capability[]; invoke(id: string, input: any, context: InvokeContext): unknown | Promise<unknown> }
export interface BridgeHost { registerProvider(provider: Provider): () => void }
export function defineProvider(provider: Provider): Provider;
export function registerProvider(ctx: { ideBridge?: BridgeHost; inject?(dependencies: string[], callback: (ctx: { ideBridge: BridgeHost }) => (() => void)): unknown }, provider: Provider): unknown;
export function checkSchema(schema: Schema, value: unknown, definition?: boolean): void;
export function jsonValue<T>(value: T): T;
export function createMockHost(): BridgeHost & { catalog(): { protocolVersion: 1; capabilities: Capability[] }; invoke(id: string, input: unknown, context: Omit<InvokeContext, 'signal' | 'emit'> & Partial<Pick<InvokeContext, 'signal' | 'emit'>>): Promise<unknown> };
