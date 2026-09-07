import { useCallback, useEffect, useState } from 'react';
import type { MemoryView } from '../../core/agent/memory';
import { api } from '../api/client';

export function useMemoryView(threadId?: string) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => window.lin?.onMemoryChanged?.(refresh), [refresh]);
  useEffect(() => {
    let active = true;
    void api.memoryInspect({ operation: 'status', ...(threadId ? { threadId } : {}) }).then((result) => {
      if (!active || result.operation !== 'status') return;
      setView(result);
      setError(null);
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [threadId, generation]);
  return { view, error, refresh };
}
