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
  };

export function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

export function previewText(text: string, maxLength: number): string {
  const first = firstLine(text) ?? text.trim();
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}
