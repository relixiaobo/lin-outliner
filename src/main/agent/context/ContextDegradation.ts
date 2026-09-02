import type {
  ContextDegradationCheckpointEntry,
  ContextDegradationCode,
} from '../../../core/agent/protocol';

export function contextDegradation(
  code: ContextDegradationCode,
  source: string,
  reference: string,
): ContextDegradationCheckpointEntry {
  return { code, source, reference };
}

export function recordContextDegradation(
  target: ContextDegradationCheckpointEntry[],
  entry: ContextDegradationCheckpointEntry,
): void {
  if (target.some((candidate) => (
    candidate.code === entry.code
    && candidate.source === entry.source
    && candidate.reference === entry.reference
  ))) return;
  target.push(entry);
}

export function appendContextDegradations(
  target: ContextDegradationCheckpointEntry[],
  entries: readonly ContextDegradationCheckpointEntry[],
): void {
  for (const entry of entries) recordContextDegradation(target, entry);
}

export function renderContextDegradation(entry: ContextDegradationCheckpointEntry): string {
  const affected = entry.source
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ')
    .trim()
    .toLowerCase();
  return `${affected || 'Historical context'} could not be restored. Re-inspect current state before relying on it.`;
}
