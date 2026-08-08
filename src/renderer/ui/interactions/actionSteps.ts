// Renderer-side execution of the renderer legs of an effect plan.
//
// Main routes a `mainRenderer` step here and WAITS for the ack before emitting
// the next step, so a failed renderer step stops the plan. Handlers are
// registered per invocation by the surface that opened it: the callbacks are
// the panel's own (`setUi`, `onRoot`, `onTogglePin`), and they stay valid after
// the menu unmounts because the menu closes before its plan settles.

import type { ComposerObject, EffectStep, RevealTarget } from '../../../core/actions/bindings';
import type { ActionStepAck, ActionStepEnvelope } from '../../../core/actions/transport';
import type { FocusHint } from '../../api/types';
import {
  requestSendContextToThreadComposer,
  requestSendNodeReferenceToThreadComposer,
} from '../../agent/agentReveal';

export interface ActionStepHandlers {
  navigate(nodeId: string, inPlace: boolean): void;
  workspace(op: 'pin' | 'unpin' | 'openSplitPane', nodeId: string): void;
  reveal(target: RevealTarget): void;
  composerHandoff(object: ComposerObject, draftText: string): void;
}

const handlersByInvocation = new Map<string, ActionStepHandlers>();
// A LAUNCHER invocation has no surface in this renderer to register handlers,
// but its plan's renderer legs still land here. The app shell installs the
// fallback so a step never dies for want of an owner.
let defaultHandlers: Partial<ActionStepHandlers> | null = null;

export function installDefaultActionStepHandlers(
  handlers: Partial<ActionStepHandlers>,
): () => void {
  defaultHandlers = handlers;
  return () => {
    if (defaultHandlers === handlers) defaultHandlers = null;
  };
}

export function registerActionStepHandlers(
  invocationRef: string,
  handlers: ActionStepHandlers,
): () => void {
  handlersByInvocation.set(invocationRef, handlers);
  return () => {
    handlersByInvocation.delete(invocationRef);
  };
}

export function runActionStep(envelope: ActionStepEnvelope): ActionStepAck {
  const scoped = handlersByInvocation.get(envelope.invocationRef);
  const handlers = scoped ?? defaultHandlers;
  if (!handlers) return { token: envelope.token, status: 'reported', code: 'no-step-handler' };
  try {
    applyStep(envelope.step, handlers);
    return { token: envelope.token, status: 'ok' };
  } catch (error) {
    return {
      token: envelope.token,
      status: 'reported',
      code: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyStep(step: EffectStep, handlers: Partial<ActionStepHandlers>): void {
  if (step.on !== 'mainRenderer') throw new Error('not-a-renderer-step');
  switch (step.kind) {
    case 'navigate':
      if (typeof step.nodeId !== 'string') throw new Error('unresolved-binding');
      required(handlers.navigate)(step.nodeId, step.inPlace);
      return;
    case 'workspace':
      if (typeof step.nodeId !== 'string') throw new Error('unresolved-binding');
      required(handlers.workspace)(step.op, step.nodeId);
      return;
    case 'reveal':
      // Only an ANCHORED opening carries the view facts a reveal needs, so the
      // fallback genuinely cannot serve one — say so rather than pretend.
      required(handlers.reveal)(step.target);
      return;
    case 'composerHandoff':
      required(handlers.composerHandoff)(step.object, step.draftText);
      return;
  }
}

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('unhandled-step-kind');
  return handler;
}

/** Installed once by the app shell; the only listener on the step channel. */
export function installActionStepListener(): () => void {
  return window.lin?.actions?.onStep(runActionStep) ?? (() => {});
}

// Commands still return `CommandResult.focus` and the caret still lands where
// they say; main now forwards that hint in the execution result because the
// renderer no longer reads its own command reply. The sink is app-level so no
// surface has to thread a focus prop through three call sites.
let focusSink: ((focus: FocusHint | null) => void) | null = null;

export function installActionFocusSink(sink: (focus: FocusHint | null) => void): () => void {
  focusSink = sink;
  return () => {
    if (focusSink === sink) focusSink = null;
  };
}

export function applyActionFocus(focus: FocusHint | null | undefined): void {
  if (focus) focusSink?.(focus);
}

// A failed or half-applied plan has to be as visible as it was when every menu
// action ran through `useCommandRunner`, whose `catch` set the error banner.
// Same app-level sink shape as the focus hint, for the same reason.
let errorSink: ((message: string | null) => void) | null = null;

export function installActionErrorSink(sink: (message: string | null) => void): () => void {
  errorSink = sink;
  return () => {
    if (errorSink === sink) errorSink = null;
  };
}

export function reportActionError(message: string | null): void {
  errorSink?.(message);
}

/**
 * The candidate list a parameter picker may act on with Enter.
 *
 * The picker is debounced and answered over IPC, so the rendered list can
 * belong to older text than what the user has typed. Enter must never commit
 * that list: before the picker went async this derivation was synchronous and
 * `items[0]` always matched the query. Returns null when the list is stale, so
 * the key is swallowed rather than applying something the user never saw.
 */
export function candidateForEnter<T>(
  candidates: { query: string; items: readonly T[] },
  query: string,
): T | null {
  if (candidates.query !== query) return null;
  return candidates.items[0] ?? null;
}

/**
 * The app-level composer handoff: a node stages as a reference, a page stages
 * as ONE untrusted additional-context entry. Installed once by the app shell so
 * a launcher-originated handoff lands even when no menu is open.
 */
export function stageComposerObject(object: ComposerObject): void {
  if (object.kind === 'node') {
    requestSendNodeReferenceToThreadComposer({ nodeId: object.nodeId, title: object.title });
    return;
  }
  requestSendContextToThreadComposer({
    key: `page:${object.contextId}`,
    label: object.label,
    value: object.value,
  });
}
