export type MemoryConsolidationRequest =
  | { readonly task: 'consolidate'; readonly reason?: string }
  | { readonly task: 'nameDay'; readonly sourceDate: string };

export interface MemoryJobPayloads {
  phase1: { readonly threadId: string };
  phase2: MemoryConsolidationRequest;
  rollback: { readonly rollbackId: string };
  reset: { readonly publicationId: string };
}

export type MemoryJobKind = keyof MemoryJobPayloads;
export type MemoryDirtyJob = { [K in MemoryJobKind]: {
  readonly key: string;
  readonly kind: K;
  readonly payload: MemoryJobPayloads[K];
  readonly attempt: number;
} }[MemoryJobKind];

/** Persisted jobs cross a decode boundary before reaching the worker. */
export function decodeMemoryJob(row: { key: string; kind: string; payload_json: string; attempt: number }): MemoryDirtyJob {
  const payload: unknown = JSON.parse(row.payload_json);
  const base = { key: row.key, attempt: row.attempt };
  switch (row.kind) {
    case 'phase1': return { ...base, kind: 'phase1', payload: { threadId: payloadString(payload, 'threadId') } };
    case 'rollback': return { ...base, kind: 'rollback', payload: { rollbackId: payloadString(payload, 'rollbackId') } };
    case 'reset': return { ...base, kind: 'reset', payload: { publicationId: payloadString(payload, 'publicationId') } };
    case 'phase2': {
      const task = payloadString(payload, 'task');
      if (task === 'nameDay') return { ...base, kind: 'phase2', payload: { task, sourceDate: payloadString(payload, 'sourceDate') } };
      if (task === 'consolidate') {
        const reason = payload && typeof payload === 'object' && 'reason' in payload ? payloadString(payload, 'reason') : undefined;
        return { ...base, kind: 'phase2', payload: { task, ...(reason ? { reason } : {}) } };
      }
    }
  }
  throw new Error(`Invalid Memory job: ${row.kind}`);
}

export function payloadString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Memory payload must contain ${key}`);
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'string' || !result.trim()) throw new Error(`Memory payload must contain ${key}`);
  return result;
}
