/**
 * What a Turn answered, as every reader of a finished Turn means it.
 *
 * Three call sites derive this — a collaboration child's terminal outcome, an
 * isolated Skill's result, and an Automation run's continuity digest — and they
 * must agree: they describe the same Turn to different audiences, so a Turn that
 * answers one way here and another way there is a bug the reader cannot see. It
 * lives in core beside the other Turn-shaped helpers so that what counts as the
 * answer (which Item types, which phases) is changed in one place.
 */
import type { ThreadItem } from './protocol';

/** Empty when the Turn left no completed final assistant text — a real outcome, not a failure. */
export function turnTerminalAnswer(items: readonly ThreadItem[]): string {
  return items
    .flatMap((item) => (
      item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase === null)
        ? [item.text.trim()]
        : []
    ))
    .filter(Boolean)
    .join('\n\n');
}
