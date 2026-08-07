// Renderer-side execution of the renderer legs of an effect plan.
//
// Main routes a `mainRenderer` step here and WAITS for the ack before emitting
// the next step, so a failed renderer step stops the plan. Handlers are
// registered per invocation by the surface that opened it: the callbacks are
// the panel's own (`setUi`, `onRoot`, `onTogglePin`), and they stay valid after
// the menu unmounts because the menu closes before its plan settles.

import type { EffectStep, RevealTarget } from '../../../core/actions/bindings';
import type { ActionStepAck, ActionStepEnvelope } from '../../../core/actions/transport';
import type { FocusHint } from '../../api/types';

export interface ActionStepHandlers {
  navigate(nodeId: string, inPlace: boolean): void;
  workspace(op: 'pin' | 'unpin' | 'openSplitPane', nodeId: string): void;
  reveal(target: RevealTarget): void;
  composerHandoff(object: { kind: 'node'; nodeId: string; title: string }, draftText: string): void;
}

const handlersByInvocation = new Map<string, ActionStepHandlers>();

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
  const handlers = handlersByInvocation.get(envelope.invocationRef);
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

function applyStep(step: EffectStep, handlers: ActionStepHandlers): void {
  if (step.on !== 'mainRenderer') throw new Error('not-a-renderer-step');
  switch (step.kind) {
    case 'navigate':
      if (typeof step.nodeId !== 'string') throw new Error('unresolved-binding');
      handlers.navigate(step.nodeId, step.inPlace);
      return;
    case 'workspace':
      if (typeof step.nodeId !== 'string') throw new Error('unresolved-binding');
      handlers.workspace(step.op, step.nodeId);
      return;
    case 'reveal':
      handlers.reveal(step.target);
      return;
    case 'composerHandoff':
      if (step.object.kind !== 'node') throw new Error('unsupported-composer-object');
      handlers.composerHandoff(step.object, step.draftText);
      return;
  }
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
