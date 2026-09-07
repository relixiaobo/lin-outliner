/**
 * What a Turn answered, as every reader of a finished Turn means it.
 *
 * Readers of completed Turns must agree on which Item types and phases form the
 * answer. This lives in core so Automation continuity and future projections do
 * not quietly invent different definitions.
 */
import type { RendererThreadItem, ThreadItem } from './protocol';

/** Empty when the Turn left no completed final assistant text — a real outcome, not a failure. */
export function turnTerminalAnswer(items: readonly (ThreadItem | RendererThreadItem)[]): string {
  return items
    .flatMap((item) => (
      item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase === null)
        ? [item.text.trim()]
        : []
    ))
    .filter(Boolean)
    .join('\n\n');
}
