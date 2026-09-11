import type { MemoryOriginSource, MemorySubject } from '../../../../core/agent/memory';

/** Missing origins cannot confer authority; personal claims need reader text. */
export function sourcesSupportSubject(subject: MemorySubject, sources: readonly (MemoryOriginSource | null | undefined)[]): boolean {
  return sources.length > 0 && sources.every((source) => source != null)
    && (subject === 'context' || sources.some((source) => source?.source === 'reader' && source.hasReaderText));
}
