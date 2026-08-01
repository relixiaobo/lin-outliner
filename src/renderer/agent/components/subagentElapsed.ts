import { useEffect, useState } from 'react';
import type { SubagentPresentation } from '../subagentPresentation';

/**
 * Live elapsed for one delegated child, shared by the transcript row and the
 * delegation card so both read the same clock rather than inventing a second.
 * Only a running child with a plausible epoch start ticks.
 */
export function useSubagentElapsedMs(presentation: SubagentPresentation): number | null {
  const [now, setNow] = useState(() => Date.now());
  const knownStart = presentation.status === 'running'
    && presentation.startedAt !== null
    && presentation.startedAt > 1_000_000_000_000
    ? presentation.startedAt
    : null;
  useEffect(() => {
    if (knownStart === null) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [knownStart]);
  return knownStart === null ? null : Math.max(0, now - knownStart);
}

export function formatSubagentDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 ? `${seconds}s` : '',
  ].filter(Boolean).join(' ');
}
