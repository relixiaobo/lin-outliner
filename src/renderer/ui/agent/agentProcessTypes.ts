import type { ToolCall } from '../../../core/agentTypes';

export interface AgentExpandState {
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean) => void;
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
    toolCall: ToolCall;
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

// Compact, locale-neutral wall-clock label for the collapsed "Worked for …"
// process header (e.g. "5s", "1m 3s", "1h 2m"). Seconds are dropped once minutes
// reach the hour mark to keep the label short.
export function formatWorkedForDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) return '<1s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && hours === 0) parts.push(`${seconds}s`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

export function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

export function previewText(text: string, maxLength: number): string {
  const first = firstLine(text) ?? text.trim();
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}
