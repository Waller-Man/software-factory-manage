import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { ChangePlan, CommitReceipt, ManageDraft } from '../types.ts';
export interface DraftRecord {
  draft: ManageDraft; owner: 'operator'; plan?: ChangePlan;
  approval?: { nonceHash: string; uiHash: string };
  receipts: CommitReceipt[];
  assistant?: { sessionId: string; workspace: string; model?: { provider: string; model: string; reasoningEffort?: string } };
}
// Storage is plugin-owned; all external requests are strictly parsed separately.
const recordSchema = z.custom<DraftRecord>((value: unknown) => {
  const row = value as DraftRecord;
  return !!row && row.owner === 'operator' && row.draft?.formatVersion === 1 && typeof row.draft.id === 'string'
    && Number.isSafeInteger(row.draft.revision) && row.draft.revision >= 0 && Array.isArray(row.draft.changes)
    && !!row.draft.bases && typeof row.draft.bases === 'object' && Array.isArray(row.receipts);
}, 'Invalid Manage draft record');
export const domainSpec = defineDomain({ name: 'software_factory_manage', version: 1, layout: 'per-record', tables: { drafts: domainTable(recordSchema) } });
export interface DraftStore {
  get(id: string): DraftRecord | undefined;
  entries(): IterableIterator<[string, DraftRecord]>;
  put(id: string, record: DraftRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}
