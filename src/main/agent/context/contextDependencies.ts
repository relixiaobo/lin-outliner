import type {
  ContextCompactionThreadItem,
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadInternalTextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadImageArtifactReference,
  ThreadResourceReference,
} from '../../../core/agent/protocol';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import { imageArtifactResourceReferences } from '../imageArtifacts';

type ContextDependencyOwner = ContextEvidenceThreadItem | ContextCompactionThreadItem;

export interface ContextPayloadDependencies {
  readonly contexts: readonly ThreadContextPayloadReference[];
  readonly internalTexts: readonly ThreadInternalTextPayloadReference[];
  readonly resources: readonly ThreadResourceReference[];
  readonly outputs: readonly ThreadItemOutputReference[];
}

export interface ThreadItemResourceUsage {
  readonly artifacts: readonly ThreadImageArtifactReference[];
  readonly genericResources: readonly ThreadResourceReference[];
}

interface ScannedThreadItemResourceUsage extends ThreadItemResourceUsage {
  readonly complete: boolean;
}

export function itemResourceReferences(item: ThreadItem): ThreadResourceReference[] {
  let references: ThreadResourceReference[] = itemToolResourceReferences(item);
  if (item.type === 'userMessage') {
    references.push(...item.content.flatMap((content) => content.type === 'attachment'
      ? [
          ...(content.source.kind === 'resource' ? [content.source.ref] : []),
          ...(content.artifactRef ? imageArtifactResourceReferences(content.artifactRef) : []),
        ]
      : []));
  } else if (item.type === 'agentMessage') {
    references.push(...(item.finalCitations ?? []).flatMap((citation) => (
      citation.resourceRef ? [citation.resourceRef] : []
    )));
  } else if (item.type === 'dynamicToolCall') {
    references.push(...(item.contentItems ?? []).flatMap((content) => (
      content.type !== 'image'
        ? []
        : imageArtifactResourceReferences(content.artifactRef)
    )));
  } else if (item.type === 'contextEvidence' || item.type === 'contextCompaction') {
    references.push(...item.resourceRefs);
  }
  return [...new Map(references.map((ref) => [resourceReferenceKey(ref), ref])).values()];
}

export function itemToolResourceReferences(item: ThreadItem): ThreadResourceReference[] {
  return 'modelCall' in item ? [...(item.resourceRefs ?? [])] : [];
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

/**
 * Classify managed resources by their semantic use, including images nested in
 * inherited-context payloads. A missing or corrupt payload makes its owner's
 * declared resources generic so retention and copying fail safe.
 */
export async function scanThreadItemResourceUsage(
  items: readonly ThreadItem[],
  readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>,
): Promise<ThreadItemResourceUsage> {
  const payloadCache = new Map<string, ScannedThreadItemResourceUsage>();
  const decodedPayloads = new Map<string, ThreadContextPayload | null>();
  const visitingPayloads = new Set<string>();

  const scanPayload = async (
    ref: ThreadContextPayloadReference,
  ): Promise<ScannedThreadItemResourceUsage> => {
    const key = contextPayloadReferenceKey(ref);
    const cached = payloadCache.get(key);
    if (cached) return cached;
    if (visitingPayloads.has(key)) return incompleteResourceUsage();
    visitingPayloads.add(key);
    let result: ScannedThreadItemResourceUsage;
    try {
      const payload = await readContext(ref);
      decodedPayloads.set(key, payload);
      if (!payload || payload.kind !== ref.kind) {
        result = incompleteResourceUsage();
      } else if (payload.kind === 'referencedResources') {
        result = normalizeResourceUsage({
          artifacts: [],
          genericResources: payload.resources.flatMap((resource) => (
            resource.resourceRef ? [resource.resourceRef] : []
          )),
          complete: true,
        });
      } else if (payload.kind === 'inheritedContext') {
        result = await scanItems(payload.turns.flatMap((turn) => turn.items));
      } else {
        result = emptyResourceUsage();
      }
    } catch {
      decodedPayloads.set(key, null);
      result = incompleteResourceUsage();
    } finally {
      visitingPayloads.delete(key);
    }
    payloadCache.set(key, result);
    return result;
  };

  const scanItem = async (item: ThreadItem): Promise<ScannedThreadItemResourceUsage> => {
    const directArtifacts = itemImageArtifactReferences(item);
    if (item.type !== 'contextEvidence' && item.type !== 'contextCompaction') {
      const toolResources = new Set(itemToolResourceReferences(item).map(resourceStorageIdentity));
      const artifactResources = new Set(directArtifacts
        .flatMap(imageArtifactResourceReferences)
        .map(resourceStorageIdentity));
      return normalizeResourceUsage({
        artifacts: directArtifacts,
        genericResources: itemResourceReferences(item).filter((ref) => (
          toolResources.has(resourceStorageIdentity(ref))
          || !artifactResources.has(resourceStorageIdentity(ref))
        )),
        complete: true,
      });
    }

    const declaredResources = itemResourceReferences(item);
    const nested = emptyMutableResourceUsage();
    const resourceBearingPayloadRefs = itemContextPayloadReferences(item).filter((ref) => (
      ref.kind === 'referencedResources' || ref.kind === 'inheritedContext'
    ));
    for (const ref of resourceBearingPayloadRefs) {
      const usage = await scanPayload(ref);
      mergeResourceUsage(nested, usage);
      try {
        const payload = decodedPayloads.get(contextPayloadReferenceKey(ref));
        if (!payload || payload.kind !== ref.kind) {
          nested.complete = false;
        } else {
          assertContextPayloadDependencies(item, payload);
        }
      } catch {
        nested.complete = false;
      }
    }
    const knownResources = new Set([
      ...nested.artifacts.flatMap(imageArtifactResourceReferences),
      ...nested.genericResources,
    ].map(resourceStorageIdentity));
    nested.genericResources.push(...declaredResources.filter((ref) => (
      !nested.complete || !knownResources.has(resourceStorageIdentity(ref))
    )));
    return normalizeResourceUsage(nested);
  };

  async function scanItems(nextItems: readonly ThreadItem[]): Promise<ScannedThreadItemResourceUsage> {
    const usage = emptyMutableResourceUsage();
    for (const item of nextItems) mergeResourceUsage(usage, await scanItem(item));
    return normalizeResourceUsage(usage);
  }

  const usage = await scanItems(items);
  return { artifacts: usage.artifacts, genericResources: usage.genericResources };
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

export function itemInternalTextPayloadReferences(item: ThreadItem): ThreadInternalTextPayloadReference[] {
  const dependencyRefs = item.type === 'contextEvidence' || item.type === 'contextCompaction'
    ? item.internalTextRefs ?? []
    : [];
  if (!('modelCall' in item) || item.modelCall.disposition === 'evidenceOnly') return [...dependencyRefs];
  const source = modelCallArgumentSource(item.modelCall);
  return source.storage === 'payload' ? [...dependencyRefs, ...source.internalTextRefs] : [...dependencyRefs];
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
    dependencies.internalTexts,
    owner.internalTextRefs,
    internalTextReferenceKey,
    'internalTextRefs',
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

export function contextPayloadDependencies(payload: ThreadContextPayload): ContextPayloadDependencies {
  switch (payload.kind) {
    case 'referencedResources':
      return emptyDependencies({
        resources: payload.resources.flatMap((resource) => resource.resourceRef ? [resource.resourceRef] : []),
      });
    case 'toolOutputProjection':
      return emptyDependencies({ outputs: [payload.outputRef] });
    case 'inheritedContext':
      return {
        contexts: uniqueReferences(
          payload.turns.flatMap((turn) => turn.items.flatMap(itemContextPayloadReferences)),
          contextPayloadReferenceKey,
        ),
        internalTexts: uniqueReferences(
          payload.turns.flatMap((turn) => turn.items.flatMap(itemInternalTextPayloadReferences)),
          internalTextReferenceKey,
        ),
        resources: uniqueReferences(
          payload.turns.flatMap((turn) => turn.items.flatMap(itemResourceReferences)),
          resourceReferenceKey,
        ),
        outputs: uniqueReferences(
          payload.turns.flatMap((turn) => turn.items.flatMap(itemOutputReferences)),
          outputReferenceKey,
        ),
      };
    case 'compactionRestoredState':
      return {
        contexts: [
          ...payload.activeSkills.map((skill) => skill.payloadRef),
          ...(payload.userViewBaselineRef ? [payload.userViewBaselineRef] : []),
          ...(payload.additionalContextBaselineRef ? [payload.additionalContextBaselineRef] : []),
          ...payload.activeObservations.map((observation) => observation.projectionRef),
        ],
        internalTexts: [],
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
    internalTexts: overrides.internalTexts ?? [],
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

function uniqueReferences<T>(references: readonly T[], key: (ref: T) => string): T[] {
  return [...new Map(references.map((ref) => [key(ref), ref])).values()];
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

export function internalTextReferenceKey(ref: ThreadInternalTextPayloadReference): string {
  return JSON.stringify([ref.id, ref.encoding, ref.byteLength]);
}

function emptyMutableResourceUsage(): {
  artifacts: ThreadImageArtifactReference[];
  genericResources: ThreadResourceReference[];
  complete: boolean;
} {
  return { artifacts: [], genericResources: [], complete: true };
}

function emptyResourceUsage(): ScannedThreadItemResourceUsage {
  return { artifacts: [], genericResources: [], complete: true };
}

function incompleteResourceUsage(): ScannedThreadItemResourceUsage {
  return { artifacts: [], genericResources: [], complete: false };
}

function mergeResourceUsage(
  target: { artifacts: ThreadImageArtifactReference[]; genericResources: ThreadResourceReference[]; complete: boolean },
  source: ScannedThreadItemResourceUsage,
): void {
  target.artifacts.push(...source.artifacts);
  target.genericResources.push(...source.genericResources);
  target.complete &&= source.complete;
}

function normalizeResourceUsage(
  usage: {
    readonly artifacts: readonly ThreadImageArtifactReference[];
    readonly genericResources: readonly ThreadResourceReference[];
    readonly complete: boolean;
  },
): ScannedThreadItemResourceUsage {
  return {
    artifacts: [...new Map(usage.artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()],
    genericResources: uniqueResourceReferences(usage.genericResources),
    complete: usage.complete,
  };
}

function uniqueResourceReferences(
  references: readonly ThreadResourceReference[],
): ThreadResourceReference[] {
  return [...new Map(references.map((ref) => [resourceStorageIdentity(ref), ref])).values()];
}

function resourceStorageIdentity(ref: ThreadResourceReference): string {
  return `${ref.id}\0${ref.fileName}`;
}
