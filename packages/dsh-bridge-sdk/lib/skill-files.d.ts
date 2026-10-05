import type { InvokeContext } from './index';
export interface SkillPlan { planId: string; action: 'create' | 'update' | 'enabled' | 'delete' | 'restore'; file: string; scope: string; before: string; after: string; expectedHash: string; afterHash: string }
export class SkillFileStore {
  constructor(options: { roots(context: InvokeContext): Record<string, string>; now?(): number });
  checked(file: string, context: InvokeContext): { file: string; scope: string };
  preview(input: { action: SkillPlan['action']; file?: string; name?: string; scope?: string; content?: string; enabled?: boolean; trashId?: string }, context: InvokeContext): SkillPlan;
  commit(planId: string, context: InvokeContext): { ok: true; action: string; file: string; scope: string; sha256: string; recoveryId?: string };
  trash(context: InvokeContext): Array<{ id: string; file: string; scope: string; time: string; action: string; skillName: string; sha256: string }>;
}
