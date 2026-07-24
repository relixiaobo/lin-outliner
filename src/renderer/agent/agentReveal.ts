type ThreadRailRevealListener = () => void;

export interface ThreadComposerNodeReferenceRequest {
  readonly nodeId: string;
  readonly title: string;
}

type ThreadComposerNodeReferenceListener = (request: ThreadComposerNodeReferenceRequest) => void;

const railRevealListeners = new Set<ThreadRailRevealListener>();
const composerReferenceListeners = new Set<ThreadComposerNodeReferenceListener>();
const pendingComposerReferences: ThreadComposerNodeReferenceRequest[] = [];

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
