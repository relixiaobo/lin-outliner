export interface AgentExpandState {
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean, anchorElement?: HTMLElement | null) => void;
}

// Compact, locale-neutral wall-clock label for an agent run (e.g. "<1s", "5s",
// "1m 3s", "1h 2m"). Shared by the "Worked for ..." work divider and
// the Run detail panel so the two never drift; seconds are dropped once
// the duration reaches whole minutes to keep the label short.
// Codex's duration format (`qd`/`Jd`): roll up through days, keep every non-zero
// unit, trim the zero ones — "45s", "1m 30s", "2m", "1h 5m 3s", "2d 3h". Sub-second
// is "<1s" (the live worked-for divider shows bare "Working" before this is ever
// called for a running turn; this only formats a settled wall-clock).
export function formatRunDuration(ms: number): string {
  const elapsed = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (elapsed < 1000) return '<1s';
  const totalSeconds = Math.round(elapsed / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  // totalSeconds ≥ 1 here, so at least one unit is non-zero.
  return parts.join(' ');
}

export function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

export function previewText(text: string, maxLength: number): string {
  const first = firstLine(text) ?? text.trim();
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}
