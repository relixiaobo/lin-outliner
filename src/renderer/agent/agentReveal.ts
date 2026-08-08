type ThreadRailRevealListener = () => void;

/**
 * A non-document context staged onto the composer — today, the page the user
 * summoned the command surface over.
 *
 * It is deliberately NOT a new authority. The agent protocol already says a
 * renderer may author `additionalContext` entries of kind `untrusted` and
 * nothing else (`core/agent/codec.ts`: "renderer input may author only
 * untrusted context"), and untrusted text can never acquire instruction
 * authority. So an external page enters as exactly that: one untrusted entry,
 * keyed so a second staging replaces rather than accumulates.
 */
export interface PendingComposerContext {
  /** Stable key — re-staging the same page replaces its entry. */
  readonly key: string;
  /** What the chip showed, so the composer can name what it is carrying. */
  readonly label: string;
  /** The untrusted value handed to the model. */
  readonly value: string;
}

export interface ThreadComposerNodeReferenceRequest {
  readonly nodeId: string;
  readonly title: string;
}

type ThreadComposerNodeReferenceListener = (request: ThreadComposerNodeReferenceRequest) => void;

type ComposerContextListener = (context: PendingComposerContext) => void;

const railRevealListeners = new Set<ThreadRailRevealListener>();
const composerReferenceListeners = new Set<ThreadComposerNodeReferenceListener>();
const composerContextListeners = new Set<ComposerContextListener>();
const pendingComposerReferences: ThreadComposerNodeReferenceRequest[] = [];
const pendingComposerContexts_ = new Map<string, PendingComposerContext>();

export function requestRevealThreadRail(): void {
  for (const listener of railRevealListeners) listener();
}

export function onThreadRailRevealRequest(listener: ThreadRailRevealListener): () => void {
  railRevealListeners.add(listener);
  if (pendingComposerReferences.length > 0) listener();
  return () => railRevealListeners.delete(listener);
}

export function requestSendNodeReferenceToThreadComposer(request: ThreadComposerNodeReferenceRequest): void {
  pendingComposerReferences.push(request);
  requestRevealThreadRail();
  for (const listener of composerReferenceListeners) listener(request);
}

export function onThreadComposerNodeReferenceRequest(
  listener: ThreadComposerNodeReferenceListener,
): () => void {
  composerReferenceListeners.add(listener);
  for (const request of [...pendingComposerReferences]) listener(request);
  return () => composerReferenceListeners.delete(listener);
}

export function acknowledgeThreadComposerNodeReferenceRequest(
  request: ThreadComposerNodeReferenceRequest,
): void {
  const index = pendingComposerReferences.indexOf(request);
  if (index >= 0) pendingComposerReferences.splice(index, 1);
}

/**
 * Stage an untrusted context onto the composer and reveal the rail. Keyed, so
 * summoning twice over the same page leaves ONE entry rather than stacking
 * duplicates into the next turn.
 */
export function requestSendContextToThreadComposer(context: PendingComposerContext): void {
  pendingComposerContexts_.set(context.key, context);
  requestRevealThreadRail();
  for (const listener of composerContextListeners) listener(context);
}

export function onThreadComposerContextRequest(listener: ComposerContextListener): () => void {
  composerContextListeners.add(listener);
  for (const context of [...pendingComposerContexts_.values()]) listener(context);
  return () => composerContextListeners.delete(listener);
}

export function acknowledgeThreadComposerContext(key: string): void {
  pendingComposerContexts_.delete(key);
}

/** The staged contexts, for a surface that must show and un-stage them. */
export function pendingComposerContexts(): PendingComposerContext[] {
  return [...pendingComposerContexts_.values()];
}

/** The staged untrusted contexts, as the protocol's `additionalContext` map. */
export function pendingComposerAdditionalContext(): Record<string, { value: string; kind: 'untrusted' }> {
  const entries: Record<string, { value: string; kind: 'untrusted' }> = {};
  for (const [key, context] of pendingComposerContexts_) {
    entries[key] = { value: context.value, kind: 'untrusted' };
  }
  return entries;
}
