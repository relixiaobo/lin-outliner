import { useEffect, useState } from 'react';

/**
 * Live elapsed for one delegated child. Only a running child with a plausible
 * epoch start ticks; a settled one has no clock left to read, and its row falls
 * back to the duration its own Turn recorded.
 *
 * This hook belongs to the leaf that DISPLAYS the value — the chip, the strip
 * row, the detail header — and to nothing above it. Owning the tick higher up
 * re-rendered an expanded child's whole transcript once a second while nothing
 * about it had changed.
 */
export function useSubagentElapsedMs(
  presentation: { readonly status: string; readonly startedAt: number | null },
): number | null {
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
