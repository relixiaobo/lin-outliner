import type { ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';

export interface AgentExpandState {
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean, anchorElement?: HTMLElement | null) => void;
}

export type AgentProcessSegmentBlock =
  | {
    kind: 'thinking';
    sourceIndex: number;
    streaming: boolean;
    text: string;
  }
  | {
    kind: 'toolCall';
    childRun?: AgentRenderChildRunEntity;
    toolCall: ToolCall;
    // Settled state from `tool_call.completed` / `.failed`; undefined while the
    // call is still executing. Authoritative over the (possibly-absent) result
    // message for deciding whether the spinner should stop.
    outcome?: AgentToolCallOutcome;
  }
  // Interim narration: assistant text emitted before the turn's final answer
  // (e.g. "let me check the weather first"). It is part of the working process,
  // not the result, so it folds into the disclosure rather than rendering as
  // prose. The final answer text stays outside the fold.
  | {
    kind: 'narration';
    sourceIndex: number;
    streaming: boolean;
    text: string;
  };

// Compact, locale-neutral wall-clock label for an agent run (e.g. "<1s", "5s",
// "1m 3s", "1h 2m"). Shared by the collapsed "Worked for …" process header and
// the child-run detail panel so the two never drift; seconds are dropped once
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
