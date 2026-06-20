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
// "1m 3s", "1h 2m 4s", "2d 3h"). Shared by the collapsed "Worked for …"
// process header and the child-run detail panel so the two never drift.
export function formatRunDuration(ms: number): string {
  const elapsed = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (elapsed < 1000) return '<1s';
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  if (hours < 24) {
    return [
      `${hours}h`,
      minuteRest > 0 ? `${minuteRest}m` : null,
      rest > 0 ? `${rest}s` : null,
    ].filter(Boolean).join(' ');
  }
  const days = Math.floor(hours / 24);
  return [
    `${days}d`,
    hours % 24 > 0 ? `${hours % 24}h` : null,
    minuteRest > 0 ? `${minuteRest}m` : null,
    rest > 0 ? `${rest}s` : null,
  ].filter(Boolean).join(' ');
}

export function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

export function previewText(text: string, maxLength: number): string {
  const first = firstLine(text) ?? text.trim();
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}
