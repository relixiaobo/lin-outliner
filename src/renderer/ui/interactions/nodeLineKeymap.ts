/**
 * Pure keymap resolver for a node line's *structural* keys — the contiguous
 * Enter / Backspace / Tab / Shift+Arrow / Arrow / Escape block of the editor
 * keymap. Returns the structural action a keydown maps to, or `null` to let it
 * fall through to default editing / browser handling.
 *
 * The caller (an editor's `handleKeyDown`) runs the earlier, editor-specific
 * blocks first — IME guard, inline-reference selection shortcuts, undo/redo,
 * mark toggles, checkbox, move — then calls this for the shared structural
 * tail, and builds the rich payloads (split slices, empty check) itself.
 *
 * See `docs/plans/archive/node-line-editor-core-design.md` §3–4. This is the shared
 * vocabulary both node-line editors map onto.
 */

export type NodeLineKeyAction =
  | { type: 'split' }
  | { type: 'backspaceAtStart' }
  | { type: 'indent'; shiftKey: boolean }
  | { type: 'shiftArrow'; direction: 'up' | 'down' }
  | { type: 'navigateUpAtStart' }
  | { type: 'navigateDownAtEnd' }
  | { type: 'escape' };

export interface NodeLineKeyContext {
  /** Selection start as a text offset. */
  from: number;
  /** Selection end as a text offset. */
  to: number;
  /** Length of the line's text. */
  textLength: number;
  /** Whether an `onShiftArrow` handler is wired (Shift+Arrow is inert without it). */
  hasShiftArrow: boolean;
}

export interface NodeLineKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function resolveNodeLineKeyAction(
  event: NodeLineKeyEvent,
  ctx: NodeLineKeyContext,
): NodeLineKeyAction | null {
  const mod = event.metaKey || event.ctrlKey;

  if (event.key === 'Enter' && !event.shiftKey) return { type: 'split' };

  if (event.key === 'Backspace') {
    // Only intercept at the very start (whole selection collapsed there);
    // otherwise let the editor delete normally.
    return ctx.from === 0 && ctx.to === 0 ? { type: 'backspaceAtStart' } : null;
  }

  if (event.key === 'Tab') return { type: 'indent', shiftKey: event.shiftKey };

  if (event.shiftKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    // Shift+Arrow extends the row selection — but only if a handler is wired.
    // Without one it is inert and must NOT fall through to plain Arrow nav.
    if (!ctx.hasShiftArrow) return null;
    return { type: 'shiftArrow', direction: event.key === 'ArrowUp' ? 'up' : 'down' };
  }

  if (event.key === 'ArrowUp') {
    return ctx.from === 0 ? { type: 'navigateUpAtStart' } : null;
  }

  if (event.key === 'ArrowDown') {
    return ctx.to >= ctx.textLength ? { type: 'navigateDownAtEnd' } : null;
  }

  if (event.key === 'Escape') return { type: 'escape' };

  return null;
}
