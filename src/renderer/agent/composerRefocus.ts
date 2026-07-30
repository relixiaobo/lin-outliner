/**
 * Focus hand-back for the agent panel ("terminal model"): a mouse click that
 * lands anywhere in the thread view and is not claimed by anything returns
 * focus to the composer, so one-shot actions (copy, fork, disclosure toggles)
 * and blank-space clicks never strand focus outside the input.
 *
 * A click is claimed when it targets a surface that owns focus or attention
 * (typing surfaces, links, node references), when it produced a text selection
 * the user still needs for copying, or when — one frame later — something other
 * than the clicked control holds focus (a popover, dialog, or inline editor
 * installed its own focus target). Keyboard-activated clicks are never
 * intercepted: keyboard focus must stay where the user put it.
 */

export interface ComposerRefocusClick {
  readonly altKey: boolean;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly detail: number;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly target: Element | null;
}

export type ComposerRefocusDecision =
  | { readonly refocus: false }
  | { readonly refocus: true; readonly control: Element | null };

const SKIP: ComposerRefocusDecision = { refocus: false };

/** Clicks inside these keep focus where the browser put it. */
const FOCUS_OWNING_TARGETS = 'a, input, textarea, select, [contenteditable="true"]';

/** One-shot controls whose retained focus is meaningless after activation. */
const ACTIVATABLE_CONTROLS = 'button, summary, [role="button"], [role="option"], [role="menuitem"]';

export function composerRefocusDecision(
  click: ComposerRefocusClick,
  selection: { readonly isCollapsed: boolean } | null,
): ComposerRefocusDecision {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return SKIP;
  // Keyboard activation (Enter/Space on a control) reports detail 0.
  if (click.detail === 0) return SKIP;
  if (click.target?.closest(FOCUS_OWNING_TARGETS)) return SKIP;
  if (selection && !selection.isCollapsed) return SKIP;
  return { refocus: true, control: click.target?.closest(ACTIVATABLE_CONTROLS) ?? null };
}

/**
 * Run one frame after the click: true when the click installed a focus target
 * of its own (self-focusing popover, dialog, inline editor), in which case the
 * composer must not steal it. Focus resting on the clicked control itself or
 * fallen back to the body means nothing claimed it.
 */
export function clickInstalledFocusTarget(
  activeElement: Element | null,
  control: Element | null,
  body: Element | null,
): boolean {
  return activeElement !== null && activeElement !== body && activeElement !== control;
}
