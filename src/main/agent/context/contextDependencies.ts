import type {
  ContextCompactionThreadItem,
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadImageArtifactReference,
  ThreadResourceReference,
} from '../../../core/agent/protocol';
import { imageArtifactResourceReferences } from '../imageArtifacts';

type ContextDependencyOwner = ContextEvidenceThreadItem | ContextCompactionThreadItem;

interface ContextPayloadDependencies {
  readonly contexts: readonly ThreadContextPayloadReference[];
  readonly resources: readonly ThreadResourceReference[];
  readonly outputs: readonly ThreadItemOutputReference[];
}

export function itemResourceReferences(item: ThreadItem): ThreadResourceReference[] {
  let references: ThreadResourceReference[];
  if (item.type === 'userMessage') {
    references = item.content.flatMap((content) => content.type === 'attachment'
      ? [
          ...(content.source.kind === 'threadPayload' ? [content.source.ref] : []),
          ...(content.artifactRef ? imageArtifactResourceReferences(content.artifactRef) : []),
        ]
      : []);
  } else if (item.type === 'dynamicToolCall') {
    references = (item.contentItems ?? []).flatMap((content) => (
      content.type !== 'image'
        ? []
        : imageArtifactResourceReferences(content.artifactRef)
    ));
  } else {
    references = item.type === 'contextEvidence' || item.type === 'contextCompaction'
      ? [...item.resourceRefs]
      : [];
  }
  return [...new Map(references.map((ref) => [resourceReferenceKey(ref), ref])).values()];
}

export function itemImageArtifactReferences(item: ThreadItem): ThreadImageArtifactReference[] {
  if (item.type === 'userMessage') {
    return item.content.flatMap((content) => (
      content.type === 'attachment' && content.artifactRef ? [content.artifactRef] : []
    ));
  }
  if (item.type === 'dynamicToolCall') {
    return (item.contentItems ?? []).flatMap((content) => content.type === 'image' ? [content.artifactRef] : []);
  }
  return [];
}

export function itemProtectedResourceReferences(item: ThreadItem): ThreadResourceReference[] {
  let references: ThreadResourceReference[];
  if (item.type === 'userMessage') {
    references = item.content.flatMap((content) => (
      content.type === 'attachment' && content.source.kind === 'threadPayload'
        ? [content.source.ref]
        : []
    ));
  } else {
    references = item.type === 'contextEvidence' || item.type === 'contextCompaction'
      ? [...item.resourceRefs]
      : [];
  }
  return [...new Map(references.map((ref) => [resourceReferenceKey(ref), ref])).values()];
}

export function itemContextPayloadReferences(item: ThreadItem): ThreadContextPayloadReference[] {
  return [
    ...itemRequiredContextPayloadReferences(item),
    ...itemToolArgumentPayloadReferences(item),
  ];
}

export function itemRequiredContextPayloadReferences(item: ThreadItem): ThreadContextPayloadReference[] {
  const contextRefs = item.type === 'contextEvidence' || item.type === 'contextCompaction'
    ? item.contextRefs.filter((ref) => ref.kind !== 'toolCallArguments')
    : [];
  if (item.type === 'contextEvidence') return [item.payloadRef, ...contextRefs];
  if (item.type !== 'contextCompaction') return [];
  return [
    item.summaryRef,
    item.restoredStateRef,
    ...(item.instructionsRef ? [item.instructionsRef] : []),
    ...contextRefs,
  ];
}

export function itemToolArgumentPayloadReferences(item: ThreadItem): ThreadContextPayloadReference[] {
  const dependencyRefs = item.type === 'contextEvidence' || item.type === 'contextCompaction'
    ? item.contextRefs.filter((ref) => ref.kind === 'toolCallArguments')
    : [];
  if (!('modelCall' in item)) return dependencyRefs;
  const modelCall = item.modelCall;
  if (modelCall.disposition === 'evidenceOnly') return dependencyRefs;
  const source = modelCall.disposition === 'replayable'
    ? modelCall.arguments
    : modelCall.redactedArguments;
  return source.storage === 'payload' ? [...dependencyRefs, source.ref] : dependencyRefs;
}

export function itemOutputReferences(item: ThreadItem): ThreadItemOutputReference[] {
  return [
    ...('outputRef' in item && item.outputRef ? [item.outputRef] : []),
    ...(item.type === 'contextEvidence' || item.type === 'contextCompaction' ? item.outputRefs : []),
  ];
}

export function assertContextPayloadDependencies(
  owner: ContextDependencyOwner,
  payload: ThreadContextPayload,
): void {
  const dependencies = contextPayloadDependencies(payload);
  assertReferencesIncluded(
    dependencies.contexts,
    owner.contextRefs,
    contextPayloadReferenceKey,
    'contextRefs',
    (ref) => ref.id,
  );
  assertReferencesIncluded(
    dependencies.resources,
    owner.resourceRefs,
    resourceReferenceKey,
    'resourceRefs',
    (ref) => `${ref.id}/${ref.fileName}`,
  );
  assertReferencesIncluded(
    dependencies.outputs,
    owner.outputRefs,
    outputReferenceKey,
    'outputRefs',
    (ref) => ref.id,
  );
}

function contextPayloadDependencies(payload: ThreadContextPayload): ContextPayloadDependencies {
  switch (payload.kind) {
    case 'referencedResources':
      return emptyDependencies({
        resources: payload.resources.flatMap((resource) => resource.resourceRef ? [resource.resourceRef] : []),
      });
    case 'toolOutputProjection':
      return emptyDependencies({ outputs: [payload.outputRef] });
    case 'inheritedContext':
      return {
        contexts: payload.turns.flatMap((turn) => turn.items.flatMap(itemContextPayloadReferences)),
        resources: payload.turns.flatMap((turn) => turn.items.flatMap(itemResourceReferences)),
        outputs: payload.turns.flatMap((turn) => turn.items.flatMap(itemOutputReferences)),
      };
    case 'compactionRestoredState':
      return {
        contexts: [
          ...payload.activeSkills.map((skill) => skill.payloadRef),
          ...(payload.userViewBaselineRef ? [payload.userViewBaselineRef] : []),
          ...(payload.additionalContextBaselineRef ? [payload.additionalContextBaselineRef] : []),
          ...payload.activeObservations.map((observation) => observation.projectionRef),
        ],
        resources: [],
        outputs: payload.activeObservations.map((observation) => observation.outputRef),
      };
    case 'turnEnvironment':
    case 'userView':
    case 'additionalContext':
    case 'skillCatalog':
    case 'skillInvocation':
    case 'roleCatalog':
    case 'compactionSummary':
    case 'compactionInstructions':
    case 'toolCallArguments':
      return emptyDependencies();
  }
}

function emptyDependencies(
  overrides: Partial<ContextPayloadDependencies> = {},
): ContextPayloadDependencies {
  return {
    contexts: overrides.contexts ?? [],
    resources: overrides.resources ?? [],
    outputs: overrides.outputs ?? [],
  };
}

function assertReferencesIncluded<T>(
  required: readonly T[],
  declared: readonly T[],
  key: (ref: T) => string,
  field: string,
  describe: (ref: T) => string,
): void {
  for (const ref of required) {
    const requiredKey = key(ref);
    if (!declared.some((candidate) => key(candidate) === requiredKey)) {
      throw new Error(`Context payload dependency is missing from Item ${field}: ${describe(ref)}`);
    }
  }
}

export function contextPayloadReferenceKey(ref: ThreadContextPayloadReference): string {
  return JSON.stringify([ref.id, ref.mimeType, ref.byteLength, ref.schemaVersion, ref.kind]);
}

export function resourceReferenceKey(ref: ThreadResourceReference): string {
  return JSON.stringify([ref.id, ref.mimeType, ref.byteLength, ref.fileName]);
}

export function outputReferenceKey(ref: ThreadItemOutputReference): string {
  return JSON.stringify([ref.id, ref.mimeType, ref.byteLength, ref.summary]);
}
