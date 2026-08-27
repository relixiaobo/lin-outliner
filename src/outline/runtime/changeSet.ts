import type { Core, CoreTransactionNodePatch, ResolvedContentTree } from '../../core/core';
import { isClientNodeId } from '../../shared/nodeId';
import type { BatchMoveNodeInput, DocumentProjection, FieldSlotMutation } from '../../core/types';
import {
  TRASH_ID,
  plainText,
  type CreateNodeTree,
  type FieldType,
  type FilterOperator,
  type FilterValueLogic,
  type Node,
  type NodeProjection,
  type SearchNodeConfig,
  type SortDirection,
  type FieldConfigPatch,
  type TagConfigPatch,
  type ViewFieldRef,
  type ViewMode,
} from '../../core/types';
import {
  canonicalChangeSetHash,
  canonicalDiffHash,
  canonicalJson,
  canonicalSha256,
} from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import {
  CaptureProvenanceSchema,
  ChangeSetSchema,
  DiffSchema,
  type Change,
  type ChangeSet,
  type Diff,
  type AssetLease,
  type DestinationPlacement,
  type NodeDraft,
  type NoChangeResult,
  type Operation,
  type TargetRef,
  type Placement,
  type UpdateInstruction,
} from '../contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';
import { checkOutlineSchema, outlineSchemaValidationDetails } from '../contract/validation';
import { createDeterministicCoreIdFactory, deterministicPublicNodeId } from './deterministicIds';
import { projectOutline, resolveTargetRef } from './projection';
import { semanticAffectedDigest, semanticNodeDigest } from './semanticDigest';
import { createSelectionIndex, resolveTargetSpec } from './selector';
import type { OutlineRuntimeRequestContext } from './server/runtimeRouter';
import type { OutlineRuntimeWorkspace } from './runtimeWorkspace';
import { isSystemFieldId } from '../../core/systemFields';
import { buildConfigIndex } from '../../core/configProjection';
import { searchNodeToQueryExpr } from '../../core/searchEngine';

interface ExecuteResult {
  readonly bindings: Readonly<Record<string, readonly string[]>>;
  readonly reviewedReplaceTargetIds: readonly string[];
}

interface CommitOptions {
  readonly undoGroup?: Operation['undoGroup'];
}

export async function diffOutlineChangeSet(
  workspace: OutlineRuntimeWorkspace,
  input: ChangeSet,
): Promise<Diff> {
  const normalized = normalizeOutlineChangeSet(workspace.forkCore(), input);
  const changeSetHash = canonicalChangeSetHash(normalized);
  const assetLeases = await resolveChangeSetAssetLeases(workspace, normalized);
  const candidate = workspace.forkCore({ idFactory: createDeterministicCoreIdFactory(changeSetHash) });
  let execution: ExecuteResult = { bindings: {}, reviewedReplaceTargetIds: [] };
  const { patch } = await candidate.transactionWithPatch('user', async () => {
    execution = await executeOutlineChangeSet(candidate, normalized, assetLeases);
  }, { operationId: `preview:${changeSetHash}`, command: 'outline_diff' });
  return diffFromPatch(normalized, changeSetHash, execution.bindings, execution.reviewedReplaceTargetIds, patch.nodes);
}

export async function commitOutlineChangeSet(
  workspace: OutlineRuntimeWorkspace,
  input: ChangeSet,
  context: OutlineRuntimeRequestContext,
  options: CommitOptions = {},
): Promise<Operation | NoChangeResult> {
  const directPayloadHash = directCommitPayloadHash(input);
  return workspace.commitPrepared({
    idempotencyKey: input.idempotencyKey,
    ...(input.idempotencyKey ? { idempotencyPayloadHash: directPayloadHash } : {}),
  }, async () => {
    const normalized = normalizeOutlineChangeSetFromProjection(
      workspace.revision(),
      workspace.projection(),
      input,
    );
    assertDirectCommitIsNonDestructive(normalized);
    const changeSetHash = canonicalChangeSetHash(normalized);
    const commitHash = directCommitHash(changeSetHash);
    const assetLeases = await resolveChangeSetAssetLeases(workspace, normalized);
    let execution: ExecuteResult = { bindings: {}, reviewedReplaceTargetIds: [] };
    return {
      origin: context.origin,
      causation: context.causation,
      source: normalized.source,
      changeSetHash,
      diffHash: commitHash,
      summary: summarizeChangeSet(normalized),
      idempotencyKey: normalized.idempotencyKey,
      ...(normalized.idempotencyKey ? { idempotencyPayloadHash: directPayloadHash } : {}),
      idFactory: createDeterministicCoreIdFactory(changeSetHash),
      undoGroup: options.undoGroup,
      assetLeases: Object.fromEntries(Object.entries(assetLeases).map(([leaseId, lease]) => [leaseId, lease.assetId])),
      execute: async (candidate) => {
        execution = await executeOutlineChangeSet(candidate, normalized, assetLeases);
      },
      ...(normalized.return ? {
        result: (candidate: Core) => normalized.return!.map((projection) => (
          projectOutline(candidate, projection, execution.bindings)
        )),
      } : {}),
      noChangeResult: (candidate: Core) => ({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        kind: 'outline.no-change',
        changeSetHash,
        diffHash: commitHash,
        revision: workspace.revision(),
        affectedNodeCount: 0,
        recovery: { state: 'not-required' },
        ...(normalized.return ? {
          result: normalized.return.map((projection) => (
            projectOutline(candidate, projection, execution.bindings)
          )),
        } : {}),
      }),
    };
  });
}

export async function applyOutlineDiff(
  workspace: OutlineRuntimeWorkspace,
  diff: Diff,
  context: OutlineRuntimeRequestContext,
  acknowledgeDestructive = false,
): Promise<Operation | NoChangeResult> {
  if (!checkOutlineSchema(DiffSchema, diff)) throw usageError('Invalid outline Diff artifact.');
  const actualDiffHash = canonicalDiffHash(diff);
  if (actualDiffHash !== diff.diffHash) {
    throw new OutlineContractError(outlineError('diff_mismatch', 'conflict', 'Diff hash does not match its content.'));
  }
  if (canonicalChangeSetHash(diff.normalizedChangeSet) !== diff.changeSetHash) {
    throw new OutlineContractError(outlineError('diff_mismatch', 'conflict', 'ChangeSet hash does not match the Diff.'));
  }
  const idempotencyKey = diff.normalizedChangeSet.idempotencyKey;
  if (!idempotencyKey) {
    throw usageError('Apply requires an idempotency key bound into the reviewed Diff.');
  }
  const settled = await workspace.settledOperation(idempotencyKey, diff.diffHash);
  if (settled) return settled;
  assertBaseState(workspace.forkCore(), diff.normalizedChangeSet);
  const assetLeases = await resolveChangeSetAssetLeases(workspace, diff.normalizedChangeSet);
  if (diff.destructive.length > 0 && !acknowledgeDestructive) {
    throw new OutlineContractError(outlineError(
      'confirmation_required',
      'confirmation',
      'This Diff contains destructive changes and requires acknowledgement.',
      { details: diff.destructive },
    ));
  }

  if (diff.affected.length === 0) {
    return {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.no-change',
      changeSetHash: diff.changeSetHash,
      diffHash: diff.diffHash,
      revision: workspace.revision(),
      affectedNodeCount: 0,
      recovery: { state: 'not-required' },
      ...(diff.normalizedChangeSet.return ? {
        result: diff.normalizedChangeSet.return.map((projection) => (
          projectOutline(workspace.forkCore(), projection, diff.bindings)
        )),
      } : {}),
    };
  }

  let execution: ExecuteResult = { bindings: {}, reviewedReplaceTargetIds: [] };
  return workspace.mutate({
    origin: context.origin,
    causation: context.causation,
    source: diff.normalizedChangeSet.source,
    changeSetHash: diff.changeSetHash,
    diffHash: diff.diffHash,
    expectedPatchHash: semanticAffectedDigest(diff.affected),
    summary: summarizeChangeSet(diff.normalizedChangeSet),
    idempotencyKey: diff.normalizedChangeSet.idempotencyKey,
    ...(diff.normalizedChangeSet.idempotencyKey ? { idempotencyPayloadHash: diff.diffHash } : {}),
    idFactory: createDeterministicCoreIdFactory(diff.changeSetHash),
    assetLeases: Object.fromEntries(Object.entries(assetLeases).map(([leaseId, lease]) => [leaseId, lease.assetId])),
    execute: async (candidate) => {
      execution = await executeOutlineChangeSet(candidate, diff.normalizedChangeSet, assetLeases);
    },
    ...(diff.normalizedChangeSet.return ? {
      result: (candidate: Core) => diff.normalizedChangeSet.return!.map((projection) => (
        projectOutline(candidate, projection, execution.bindings)
      )),
    } : {}),
  });
}

export function normalizeOutlineChangeSet(core: Core, input: ChangeSet): ChangeSet {
  return normalizeOutlineChangeSetFromProjection(core.revision(), core.projection(), input);
}

export function normalizeOutlineChangeSetFromProjection(
  revision: number,
  projection: DocumentProjection,
  input: ChangeSet,
): ChangeSet {
  if (!checkOutlineSchema(ChangeSetSchema, input)) {
    throw new OutlineContractError(outlineError(
      'invalid_input',
      'usage',
      'Input does not match the public ChangeSet schema.',
      { details: { validation: outlineSchemaValidationDetails(ChangeSetSchema, input) } },
    ));
  }
  if (input.base?.revision !== undefined && input.base.revision !== revision) {
    throw new OutlineContractError(outlineError(
      'stale_revision',
      'conflict',
      `ChangeSet revision ${input.base.revision} does not match Runtime revision ${revision}.`,
    ));
  }
  const normalized = clone(input);
  const publicIdSeed = canonicalSha256(input);
  normalized.operations = normalized.operations.map((change, operationIndex) => {
    if (change.op !== 'create') return change;
    if ('resource' in change) {
      const drafts = change.definitionType === 'tag' ? change.template : change.options;
      if (!drafts) return change;
      const normalizedDrafts = drafts.map((draft, nodeIndex) => normalizeDraftIds(
        draft,
        publicIdSeed,
        `${operationIndex}:${nodeIndex}`,
      ));
      return change.definitionType === 'tag'
        ? { ...change, template: normalizedDrafts }
        : { ...change, options: normalizedDrafts };
    }
    return {
      ...change,
      nodes: change.nodes.map((draft, nodeIndex) => normalizeDraftIds(
        draft,
        publicIdSeed,
        `${operationIndex}:${nodeIndex}`,
      )),
    };
  });

  const index = createSelectionIndex(projection);
  const expected = new Map<string, string>();
  for (const [nodeId, digest] of Object.entries(input.base?.nodes ?? {})) {
    const node = index.byId.get(nodeId);
    if (!node || semanticNodeDigest(node) !== digest) {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        `ChangeSet Node precondition failed: ${nodeId}`,
      ));
    }
    expected.set(nodeId, digest);
  }
  const bindings = new Set<string>();
  for (const [operationIndex, change] of normalized.operations.entries()) {
    for (const reference of changeTargetRefs(change)) {
      if ('binding' in reference) {
        if (!bindings.has(reference.binding)) {
          throw usageError(`ChangeSet operation ${operationIndex} forward-references binding: ${reference.binding}`);
        }
        continue;
      }
      if (isVirtualSystemFieldTarget(change, reference)) continue;
      for (const nodeId of resolveTargetSpec(index, reference.target)) {
        addExpectedNode(index.byId.get(nodeId), expected);
        const parentId = index.byId.get(nodeId)?.parentId;
        if (parentId) addExpectedNode(index.byId.get(parentId), expected);
      }
    }
    const binding = changeBinding(change);
    if (binding) {
      if (bindings.has(binding)) throw usageError(`ChangeSet binding is duplicated: ${binding}`);
      bindings.add(binding);
    }
  }
  normalized.base = {
    revision,
    nodes: Object.fromEntries([...expected].sort(([left], [right]) => compareText(left, right))),
  };
  return normalized;
}

export async function executeOutlineChangeSet(
  core: Core,
  changeSet: ChangeSet,
  assetLeases: Readonly<Record<string, AssetLease>> = {},
): Promise<ExecuteResult> {
  const baseIndex = createSelectionIndex(core.projection());
  const bindings: Record<string, readonly string[]> = {};
  const reviewedReplaceTargetIds = new Set<string>();
  for (const [operationIndex, change] of changeSet.operations.entries()) {
    try {
      const result = await executeChange(core, baseIndex, bindings, change, operationIndex, assetLeases);
      if (change.op === 'update' && change.changes.some(isReviewedTextReplaceInstruction)) {
        for (const targetId of result) reviewedReplaceTargetIds.add(targetId);
      }
      const binding = changeBinding(change);
      if (binding) bindings[binding] = Object.freeze([...result]);
    } catch (error) {
      if (error instanceof OutlineContractError) throw error;
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        `ChangeSet operation ${operationIndex} (${change.op}) failed.`,
        { details: error instanceof Error ? error.message : String(error) },
      ));
    }
  }
  return {
    bindings: Object.freeze({ ...bindings }),
    reviewedReplaceTargetIds: Object.freeze([...reviewedReplaceTargetIds]),
  };
}

function assertBaseState(core: Core, changeSet: ChangeSet): void {
  if (changeSet.base?.revision !== core.revision()) {
    throw new OutlineContractError(outlineError(
      'stale_revision',
      'conflict',
      'The Runtime revision changed after this Diff was created.',
      { details: { expected: changeSet.base?.revision, actual: core.revision() } },
    ));
  }
  const state = core.state();
  for (const [nodeId, digest] of Object.entries(changeSet.base?.nodes ?? {})) {
    if (semanticNodeDigest(state.nodes[nodeId] ?? null) !== digest) {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        `A targeted Node changed after this Diff was created: ${nodeId}`,
      ));
    }
  }
}

async function executeChange(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  change: Change,
  operationIndex: number,
  assetLeases: Readonly<Record<string, AssetLease>>,
): Promise<readonly string[]> {
  switch (change.op) {
    case 'resolve': return resolveTargetSpec(baseIndex, change.target);
    case 'ensure': return executeEnsure(core, baseIndex, bindings, change);
    case 'create': {
      if ('resource' in change) return executeCreateDefinition(core, change, operationIndex, assetLeases);
      const destinations = resolveDestinationPlacements(core, baseIndex, bindings, change.placement);
      const created: string[] = [];
      for (const [parentIndex, destination] of destinations.entries()) {
        const fastTrees = change.nodes.every(isResolvedContentDraft)
          ? change.nodes.map((draft, draftIndex) => resolvedContentTree(
              draft,
              `${operationIndex}:${parentIndex}:${draftIndex}`,
              parentIndex === 0,
            ))
          : undefined;
        if (fastTrees && core.tryCreateResolvedContentTrees(destination.parentId, destination.index, fastTrees)) {
          created.push(...fastTrees.map((tree) => tree.id));
          continue;
        }
        for (const [draftIndex, draft] of change.nodes.entries()) {
          const copyPath = `${operationIndex}:${parentIndex}:${draftIndex}`;
          created.push(createDraft(
            core,
            destination.parentId,
            destination.index === undefined ? undefined : destination.index + draftIndex,
            draft,
            copyPath,
            parentIndex === 0,
            assetLeases,
          ));
        }
      }
      return created;
    }
    case 'update': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      for (const targetId of targetIds) {
        for (const instruction of change.changes) executeUpdate(
          core,
          baseIndex,
          bindings,
          targetId,
          instruction,
          assetLeases,
        );
      }
      return targetIds;
    }
    case 'move': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      if (change.placement.kind === 'previous') {
        core.batchMoveNodesUp([...targetIds]);
        return targetIds;
      }
      if (change.placement.kind === 'next') {
        core.batchMoveNodesDown([...targetIds]);
        return targetIds;
      }
      const destination = exactlyOneDestination(resolveDestinationPlacements(
        core,
        baseIndex,
        bindings,
        change.placement,
      ), 'move destination');
      core.batchMoveNodes(planDestinationMoves(core, targetIds, destination));
      return targetIds;
    }
    case 'duplicate': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      const created: string[] = [];
      if (change.placement.kind === 'previous' || change.placement.kind === 'next') {
        for (const targetId of targetIds) {
          const duplicateId = core.batchDuplicateNodes([targetId]).focus?.nodeId;
          if (!duplicateId) throw new Error(`Core did not return the duplicate root for ${targetId}`);
          if (change.placement.kind === 'previous') {
            const state = core.state();
            const source = state.nodes[targetId];
            const parent = source?.parentId ? state.nodes[source.parentId] : undefined;
            if (!source?.parentId || !parent) throw new Error(`Duplicate source has no parent: ${targetId}`);
            core.moveNode(duplicateId, source.parentId, parent.children.indexOf(targetId));
          }
          created.push(duplicateId);
        }
        return created;
      }
      const destination = exactlyOneDestination(resolveDestinationPlacements(
        core,
        baseIndex,
        bindings,
        change.placement,
      ), 'duplicate destination');
      for (const [index, targetId] of targetIds.entries()) {
        const duplicateId = core.batchDuplicateNodes([targetId]).focus?.nodeId;
        if (!duplicateId) throw new Error(`Core did not return the duplicate root for ${targetId}`);
        core.moveNode(
          duplicateId,
          destination.parentId,
          destination.index === undefined ? undefined : destination.index + index,
        );
        created.push(duplicateId);
      }
      return created;
    }
    case 'merge': {
      const sourceIds = resolveTargetRef(baseIndex, change.sources, bindings);
      const targetId = exactlyOne(resolveTargetRef(baseIndex, change.target, bindings), 'merge target');
      const state = core.state();
      const targetType = state.nodes[targetId]?.type;
      if ((targetType === 'tagDef' || targetType === 'fieldDef')
        && sourceIds.every((sourceId) => state.nodes[sourceId]?.type === targetType)) {
        core.mergeDefinitions(targetId, [...sourceIds]);
      } else {
        for (const sourceId of sourceIds) core.mergeNodeInto(sourceId, targetId);
      }
      return [targetId];
    }
    case 'template': {
      const tagId = exactlyOne(resolveTargetRef(baseIndex, change.tag, bindings), 'template tag');
      core.applyTemplateToTaggedNodes(tagId);
      return [tagId];
    }
    case 'lifecycle': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      const effectiveTargets = change.action === 'purge' && change.contents && targetIds.includes(TRASH_ID)
        ? [...core.state().nodes[TRASH_ID]?.children ?? []]
        : targetIds;
      if (change.action === 'trash') core.batchTrashNodes([...effectiveTargets]);
      else if (change.action === 'restore') for (const targetId of effectiveTargets) core.restoreNode(targetId);
      else for (const targetId of effectiveTargets) core.deleteNode(targetId);
      return effectiveTargets;
    }
  }
}

interface ResolvedDestination {
  readonly parentId: string;
  readonly index?: number;
}

function resolveDestinationPlacements(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  placement: DestinationPlacement,
): readonly ResolvedDestination[] {
  if (placement.kind === 'first' || placement.kind === 'last' || placement.kind === 'index') {
    const parentIds = resolveTargetRef(baseIndex, placement.parent, bindings);
    return parentIds.map((parentId) => ({
      parentId,
      ...(placement.kind === 'first'
        ? { index: 0 }
        : placement.kind === 'index'
          ? { index: placement.index }
          : {}),
    }));
  }
  const siblingId = exactlyOne(resolveTargetRef(baseIndex, placement.sibling, bindings), `${placement.kind} sibling`);
  const state = core.state();
  const sibling = state.nodes[siblingId];
  const parent = sibling?.parentId ? state.nodes[sibling.parentId] : undefined;
  if (!sibling?.parentId || !parent) throw usageError(`Placement sibling has no parent: ${siblingId}`);
  const siblingIndex = parent.children.indexOf(siblingId);
  if (siblingIndex < 0) throw usageError(`Placement sibling is absent from its parent: ${siblingId}`);
  return [{
    parentId: sibling.parentId,
    index: siblingIndex + (placement.kind === 'after' ? 1 : 0),
  }];
}

function exactlyOneDestination(
  destinations: readonly ResolvedDestination[],
  label: string,
): ResolvedDestination {
  if (destinations.length !== 1) throw usageError(`${label} must resolve to exactly one parent.`);
  return destinations[0]!;
}

function planDestinationMoves(
  core: Core,
  targetIds: readonly string[],
  destination: ResolvedDestination,
): readonly BatchMoveNodeInput[] {
  const state = core.state();
  const destinationNode = state.nodes[destination.parentId];
  if (!destinationNode) throw usageError(`Move destination does not exist: ${destination.parentId}`);
  const selected = new Set(targetIds);
  const anchorId = destination.index === undefined
    ? undefined
    : destinationNode.children.slice(destination.index).find((childId) => !selected.has(childId));
  const childrenByParent = new Map<string, string[]>();
  const parentByNode = new Map(targetIds.map((nodeId) => [nodeId, state.nodes[nodeId]?.parentId]));
  const children = (parentId: string): string[] => {
    const existing = childrenByParent.get(parentId);
    if (existing) return existing;
    const planned = [...(state.nodes[parentId]?.children ?? [])];
    childrenByParent.set(parentId, planned);
    return planned;
  };
  const moves: BatchMoveNodeInput[] = [];
  for (const targetId of targetIds) {
    const previousParentId = parentByNode.get(targetId);
    if (previousParentId) {
      const previousChildren = children(previousParentId);
      const previousIndex = previousChildren.indexOf(targetId);
      if (previousIndex >= 0) previousChildren.splice(previousIndex, 1);
    }
    const destinationChildren = children(destination.parentId);
    const anchorIndex = anchorId ? destinationChildren.indexOf(anchorId) : -1;
    const index = anchorIndex >= 0 ? anchorIndex : destinationChildren.length;
    destinationChildren.splice(index, 0, targetId);
    parentByNode.set(targetId, destination.parentId);
    moves.push({ nodeId: targetId, parentId: destination.parentId, index });
  }
  return moves;
}

function placementTargetRefs(placement: Placement | DestinationPlacement): readonly TargetRef[] {
  if (placement.kind === 'previous' || placement.kind === 'next') return [];
  return [placement.kind === 'before' || placement.kind === 'after' ? placement.sibling : placement.parent];
}

function executeCreateDefinition(
  core: Core,
  change: Extract<Change, { op: 'create'; resource: 'definition' }>,
  operationIndex: number,
  assetLeases: Readonly<Record<string, AssetLease>>,
): readonly string[] {
  const existing = core.projection().nodes.find((node) => (
    node.type === (change.definitionType === 'tag' ? 'tagDef' : 'fieldDef')
    && node.content.text.trim().toLocaleLowerCase() === change.name.trim().toLocaleLowerCase()
  ));
  if (existing) throw usageError(`Definition already exists: ${change.name}`);
  const outcome = change.definitionType === 'tag'
    ? core.createTag(change.name, change.id)
    : core.createFieldDefinition(change.name, change.config?.fieldType ?? 'plain', change.id);
  const definitionId = outcome.focus?.nodeId;
  if (!definitionId) throw new Error(`Core did not create definition: ${change.name}`);
  if (change.config && Object.keys(change.config).length > 0) {
    if (change.definitionType === 'tag') core.setTagConfig(definitionId, change.config);
    else core.setFieldConfig(definitionId, change.config);
  }
  const children = change.definitionType === 'tag' ? change.template : change.options;
  for (const [childIndex, draft] of (children ?? []).entries()) {
    createDraft(core, definitionId, null, draft, `${operationIndex}:0:${childIndex}`, true, assetLeases);
  }
  return [definitionId];
}

function executeEnsure(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  change: Extract<Change, { op: 'ensure' }>,
): readonly string[] {
  if (change.resource === 'date') {
    const { year, month, day } = parseLocalDate(change.date);
    const nodeId = core.ensureDateNode(year, month, day).focus?.nodeId;
    if (!nodeId) throw new Error(`Core did not resolve date: ${change.date}`);
    return [nodeId];
  }
  if (change.resource === 'tag-search') {
    const tagId = exactlyOne(resolveTargetRef(baseIndex, change.tag, bindings), 'tag search definition');
    const nodeId = core.ensureTagSearch(tagId).focus?.nodeId;
    if (!nodeId) throw new Error(`Core did not resolve tag search: ${tagId}`);
    return [nodeId];
  }
  const existing = core.projection().nodes.find((node) => (
    node.type === (change.definitionType === 'tag' ? 'tagDef' : 'fieldDef')
    && node.content.text.trim().toLocaleLowerCase() === change.name.trim().toLocaleLowerCase()
  ));
  if (existing) {
    if (change.id && existing.id !== change.id) {
      throw usageError(`Definition name is already bound to another ID: ${change.name}`);
    }
    return [existing.id];
  }
  if (change.id) {
    const nodeAtId = core.projection().nodes.find((node) => node.id === change.id);
    if (nodeAtId) throw usageError(`Definition ID is already in use: ${change.id}`);
  }
  const outcome = change.definitionType === 'tag'
    ? core.createTag(change.name, change.id)
    : core.createFieldDefinition(change.name, (change.fieldType ?? 'plain') as FieldType, change.id);
  if (!outcome.focus?.nodeId) throw new Error(`Core did not create definition: ${change.name}`);
  if (change.definitionType === 'tag' && change.extends) {
    const extendsId = exactlyOne(resolveTargetRef(baseIndex, change.extends, bindings), 'extended tag definition');
    core.setTagConfig(outcome.focus.nodeId, { extends: extendsId });
  }
  return [outcome.focus.nodeId];
}

function createDraft(
  core: Core,
  parentId: string,
  index: number | null | undefined,
  draft: NodeDraft,
  copyPath: string,
  preserveId: boolean,
  assetLeases: Readonly<Record<string, AssetLease>>,
): string {
  const id = preserveId ? draft.id! : deterministicPublicNodeId(draft.id!, copyPath);
  const metadata = isRecord(draft.metadata) ? draft.metadata : {};
  if (metadata.capture !== undefined) {
    if (!checkOutlineSchema(CaptureProvenanceSchema, metadata.capture)) {
      throw usageError('NodeDraft metadata.capture does not match CaptureProvenance');
    }
    core.createCapture({
      destinationParentId: parentId,
      index,
      title: draft.content,
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      metadata: metadata.capture,
      children: [],
    }, id);
  } else if (draft.type === 'reference') {
    if (!draft.referenceTargetId) throw new Error('Reference draft requires referenceTargetId');
    core.addReference(parentId, draft.referenceTargetId, index, id);
  } else if (draft.type === 'image') {
    const lease = draft.assetLeaseId ? requiredAssetLease(draft.assetLeaseId, assetLeases) : undefined;
    core.createImageNode(parentId, index, {
      ...(lease ? { assetId: lease.assetId } : {}),
      ...(draft.mediaUrl ? { mediaUrl: draft.mediaUrl } : {}),
      ...(typeof metadata.width === 'number'
        ? { width: metadata.width }
        : lease?.metadata.imageWidth !== undefined ? { width: lease.metadata.imageWidth } : {}),
      ...(typeof metadata.height === 'number'
        ? { height: metadata.height }
        : lease?.metadata.imageHeight !== undefined ? { height: lease.metadata.imageHeight } : {}),
      ...(typeof metadata.alt === 'string' ? { alt: metadata.alt } : {}),
      name: draft.content.text,
    }, id);
  } else if (draft.type === 'attachment') {
    const lease = requiredAssetLease(draft.assetLeaseId, assetLeases);
    core.createAttachmentNode(parentId, index, {
      assetId: lease.assetId,
      mimeType: lease.metadata.mimeType,
      originalFilename: lease.metadata.originalFilename ?? draft.content.text,
      fileSize: lease.metadata.byteSize,
      thumbnailAssetId: lease.metadata.thumbnailAssetId,
      pdfPageCount: lease.metadata.pdfPageCount,
      audioDurationMs: lease.metadata.audioDurationMs,
      videoDurationMs: lease.metadata.videoDurationMs,
    }, id);
  } else if (draft.type === 'search') {
    if (!isRecord(metadata.query)) throw new Error('Search draft requires metadata.query');
    core.createSearchNode(parentId, index, {
      title: draft.content.text,
      query: metadata.query as unknown as SearchNodeConfig['query'],
    }, undefined, id);
  } else {
    if (draft.type === 'tagDef' || draft.type === 'fieldDef' || draft.type === 'fieldEntry') {
      throw new Error(`Definition and field-entry drafts must use ensure or field changes: ${draft.type}`);
    }
    core.createNode(parentId, index, draft.content.text, id);
    if (draft.content.marks.length > 0 || draft.content.inlineRefs.length > 0) {
      core.applyNodeTextPatch(id, { ops: [{ type: 'replace_all', content: draft.content }] });
    }
    if (draft.type === 'codeBlock') core.setCodeBlock(id, draft.codeLanguage);
  }
  if (draft.description !== undefined && !isRecord(metadata.capture)) core.updateNodeDescription(id, draft.description);
  if (draft.checkbox) core.setNodeCheckboxVisible(id, true);
  if (draft.done) core.toggleDone(id);
  for (const tagId of draft.tags ?? []) core.applyTag(id, tagId);
  for (const field of draft.fields ?? []) {
    if (field.values.length === 0) continue;
    core.updateFieldSlot(id, field.fieldDefId, { kind: 'appendNodes', nodes: field.values.map(toCoreTree) });
  }
  for (const [childIndex, child] of draft.children.entries()) {
    createDraft(core, id, null, child, `${copyPath}:${childIndex}`, preserveId, assetLeases);
  }
  return id;
}

function isResolvedContentDraft(draft: NodeDraft): boolean {
  return (draft.type === undefined || draft.type === 'plain' || draft.type === 'codeBlock')
    && draft.content.inlineRefs.length === 0
    && draft.fields === undefined
    && draft.metadata === undefined
    && (draft.tags ?? []).every((tagId) => typeof tagId === 'string')
    && draft.children.every(isResolvedContentDraft);
}

function resolvedContentTree(
  draft: NodeDraft,
  copyPath: string,
  preserveId: boolean,
): ResolvedContentTree {
  return {
    id: preserveId ? draft.id! : deterministicPublicNodeId(draft.id!, copyPath),
    content: draft.content,
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.type ? { type: draft.type as 'plain' | 'codeBlock' } : {}),
    ...(draft.codeLanguage !== undefined ? { codeLanguage: draft.codeLanguage } : {}),
    ...(draft.checkbox !== undefined ? { checkbox: draft.checkbox } : {}),
    ...(draft.done !== undefined ? { done: draft.done } : {}),
    ...(draft.tags ? { tagIds: draft.tags } : {}),
    children: draft.children.map((child, index) => resolvedContentTree(
      child,
      `${copyPath}:${index}`,
      preserveId,
    )),
  };
}

function executeUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  targetId: string,
  instruction: Extract<Change, { op: 'update' }>['changes'][number],
  assetLeases: Readonly<Record<string, AssetLease>>,
): void {
  // Tag commands are already idempotent in Core. Avoid cloning the complete
  // document merely to preflight each tag edit in a large ChangeSet.
  const current = instruction.kind === 'tag' ? undefined : core.state().nodes[targetId];
  if (instruction.kind === 'content') {
    if (current && canonicalJson(current.content) === canonicalJson(instruction.value)) return;
    core.applyNodeTextPatch(targetId, { ops: [{ type: 'replace_all', content: instruction.value }] });
  } else if (instruction.kind === 'description') {
    if ((current?.description ?? null) === instruction.value) return;
    core.updateNodeDescription(targetId, instruction.value);
  } else if (instruction.kind === 'text-patch') {
    if (instruction.field === 'content') core.applyNodeTextPatch(targetId, instruction.patch);
    else {
      const current = core.state().nodes[targetId]?.description ?? '';
      core.updateNodeDescription(targetId, `${current.slice(0, instruction.from)}${instruction.value}${current.slice(instruction.to)}`);
    }
  } else if (instruction.kind === 'code') {
    const node = current;
    if (node?.type === 'codeBlock' && (node.codeLanguage ?? '') === instruction.language) return;
    if (node?.type === 'codeBlock') core.setCodeLanguage(targetId, instruction.language);
    else core.setCodeBlock(targetId, instruction.language);
  } else if (instruction.kind === 'checkbox') {
    const visible = current && 'checkbox' in current ? current.checkbox === true : false;
    if (visible === instruction.visible) return;
    core.setNodeCheckboxVisible(targetId, instruction.visible);
  } else if (instruction.kind === 'done') {
    const done = (core.state().nodes[targetId]?.completedAt ?? 0) > 0;
    if (done !== instruction.value) core.toggleDone(targetId);
  } else if (instruction.kind === 'tag') {
    const tagId = exactlyOne(resolveTargetRef(baseIndex, instruction.tag, bindings), 'tag definition');
    if (instruction.action === 'add') core.applyTag(targetId, tagId);
    else core.removeTag(targetId, tagId);
  } else if (instruction.kind === 'field') {
    executeFieldUpdate(core, baseIndex, bindings, targetId, instruction);
  } else if (instruction.kind === 'field-slot') {
    executeFieldSlotUpdate(core, baseIndex, bindings, targetId, instruction, assetLeases);
  } else if (instruction.kind === 'definition') {
    if (!definitionPatchChanges(core, targetId, instruction)) return;
    if (instruction.definitionType === 'tag') core.setTagConfig(targetId, instruction.patch as TagConfigPatch);
    else core.setFieldConfig(targetId, instruction.patch as FieldConfigPatch);
  } else if (instruction.kind === 'reference') {
    const referenceTargetId = exactlyOne(resolveTargetRef(baseIndex, instruction.target, bindings), 'reference target');
    if (instruction.action === 'add') core.addReference(targetId, referenceTargetId);
    else if (instruction.action === 'retarget') core.setReferenceTarget(targetId, referenceTargetId);
    else if (instruction.action === 'replace') core.replaceNodeWithReference(targetId, referenceTargetId);
    else if (instruction.action === 'inline') {
      if (current?.type === 'reference') {
        core.convertReferenceToInlineNode(targetId, instruction.replacementId);
      }
      else {
        if (referenceTargetId === targetId) {
          throw usageError('reference inline requires REFERENCE when TARGET is a content Node.');
        }
        core.replaceNodeWithInlineReference(targetId, referenceTargetId);
      }
    }
    else if (instruction.action === 'restore') {
      core.restoreInlineReferenceNodeToReference(
        targetId,
        referenceTargetId,
        instruction.replacementId,
      );
    }
  } else if (instruction.kind === 'view') {
    executeViewUpdate(core, baseIndex, bindings, targetId, instruction);
  } else if (instruction.kind === 'search') {
    if (instruction.action === 'refresh') core.refreshSearchNodeResults(targetId);
    else {
      const state = core.state();
      const node = state.nodes[targetId];
      if (node?.type !== 'search') throw new Error('search set target must be a Search Node');
      const resolved = searchNodeToQueryExpr(state, targetId);
      if (!resolved.ok || !resolved.query) throw new Error('search set could not resolve the current query');
      const title = instruction.title ?? node.content.text;
      const query = instruction.query ?? resolved.query;
      if (title !== node.content.text || canonicalJson(query) !== canonicalJson(resolved.query)) {
        core.setSearchNode(targetId, { title, query });
      }
    }
  } else if (instruction.kind === 'icon') {
    const value = instruction.value && (instruction.iconKind === 'image' || instruction.iconKind === 'generated')
      ? requiredAssetLease(instruction.value, assetLeases).assetId
      : instruction.value;
    if ((current?.icon ?? null) === (value ?? null)
      && (!value || (current?.iconKind ?? 'emoji') === (instruction.iconKind ?? 'emoji'))) return;
    core.setNodeIcon(targetId, value, instruction.iconKind as Parameters<Core['setNodeIcon']>[2]);
  } else if (instruction.kind === 'banner') {
    core.setNodeBanner(
      targetId,
      instruction.assetLeaseId ? requiredAssetLease(instruction.assetLeaseId, assetLeases).assetId : null,
      instruction.position,
    );
  } else {
    core.setNodeImage(targetId, {
      ...(instruction.assetLeaseId ? { assetId: requiredAssetLease(instruction.assetLeaseId, assetLeases).assetId } : {}),
      ...(instruction.mediaUrl ? { mediaUrl: instruction.mediaUrl } : {}),
      width: instruction.width,
      height: instruction.height,
    });
  }
}

async function resolveChangeSetAssetLeases(
  workspace: OutlineRuntimeWorkspace,
  changeSet: ChangeSet,
): Promise<Readonly<Record<string, AssetLease>>> {
  const leaseIds = collectChangeSetAssetLeaseIds(changeSet);
  const leases = await workspace.assets.resolveLeases(leaseIds);
  return Object.fromEntries(leases);
}

function collectChangeSetAssetLeaseIds(changeSet: ChangeSet): readonly string[] {
  const result = new Set<string>();
  const visitDraft = (draft: NodeDraft) => {
    if (draft.assetLeaseId) result.add(draft.assetLeaseId);
    for (const child of draft.children) visitDraft(child);
    for (const field of draft.fields ?? []) for (const value of field.values) visitDraft(value);
  };
  for (const change of changeSet.operations) {
    if (change.op === 'create') {
      const drafts = 'resource' in change
        ? (change.definitionType === 'tag' ? change.template : change.options) ?? []
        : change.nodes;
      for (const draft of drafts) visitDraft(draft);
    }
    if (change.op !== 'update') continue;
    for (const instruction of change.changes) {
      if (instruction.kind === 'banner' && instruction.assetLeaseId) result.add(instruction.assetLeaseId);
      if (instruction.kind === 'image' && instruction.assetLeaseId) result.add(instruction.assetLeaseId);
      if (instruction.kind === 'field-slot'
        && (instruction.mutation.action === 'append-image' || instruction.mutation.action === 'append-attachment')
        && instruction.mutation.assetLeaseId) {
        result.add(instruction.mutation.assetLeaseId);
      }
      if (instruction.kind === 'icon'
        && instruction.value
        && (instruction.iconKind === 'image' || instruction.iconKind === 'generated')) {
        result.add(instruction.value);
      }
    }
  }
  return [...result].sort();
}

function executeFieldSlotUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  ownerId: string,
  instruction: Extract<Extract<Change, { op: 'update' }>['changes'][number], { kind: 'field-slot' }>,
  assetLeases: Readonly<Record<string, AssetLease>>,
): void {
  const fieldDefId = exactlyOne(resolveTargetRef(baseIndex, instruction.field, bindings), 'field definition');
  const mutation = instruction.mutation;
  const common = mutation.entryId ? { entryId: mutation.entryId } : {};
  let lowered: FieldSlotMutation;
  if (mutation.action === 'accept-default') {
    lowered = { kind: 'acceptDefault' };
  } else if (mutation.action === 'append-text') {
    lowered = {
      kind: 'appendText',
      text: mutation.text,
      ...(mutation.id ? { id: mutation.id } : {}),
      ...(mutation.collect === true ? { collect: true } : {}),
      ...common,
    };
  } else if (mutation.action === 'append-reference') {
    lowered = {
      kind: 'appendReference',
      targetId: exactlyOne(resolveTargetRef(baseIndex, mutation.target, bindings), 'field reference target'),
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else if (mutation.action === 'select-option') {
    lowered = {
      kind: 'selectOption',
      optionNodeId: exactlyOne(resolveTargetRef(baseIndex, mutation.option, bindings), 'field option'),
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else if (mutation.action === 'remove-value') {
    const valueId = exactlyOne(resolveTargetRef(baseIndex, mutation.value, bindings), 'field value');
    core.removeFieldValue(valueId);
    return;
  } else if (mutation.action === 'append-nodes') {
    lowered = {
      kind: 'appendNodes',
      nodes: mutation.nodes.map(toCoreTree),
      ...(mutation.firstTags ? {
        firstTagIds: mutation.firstTags.map((tag) => exactlyOne(
          resolveTargetRef(baseIndex, tag, bindings),
          'field value tag',
        )),
      } : {}),
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else if (mutation.action === 'append-field') {
    lowered = {
      kind: 'appendField',
      name: mutation.name,
      fieldType: mutation.fieldType,
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else if (mutation.action === 'append-image') {
    const lease = mutation.assetLeaseId
      ? requiredAssetLease(mutation.assetLeaseId, assetLeases)
      : undefined;
    lowered = {
      kind: 'appendImage',
      ...(lease ? { assetId: lease.assetId } : {}),
      ...(mutation.mediaUrl ? { mediaUrl: mutation.mediaUrl } : {}),
      width: mutation.width,
      height: mutation.height,
      alt: mutation.alt,
      name: mutation.name,
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else if (mutation.action === 'append-attachment') {
    const lease = requiredAssetLease(mutation.assetLeaseId, assetLeases);
    lowered = {
      kind: 'appendAttachment',
      assetId: lease.assetId,
      mimeType: lease.metadata.mimeType,
      originalFilename: lease.metadata.originalFilename,
      fileSize: lease.metadata.byteSize,
      thumbnailAssetId: lease.metadata.thumbnailAssetId,
      pdfPageCount: lease.metadata.pdfPageCount,
      audioDurationMs: lease.metadata.audioDurationMs,
      videoDurationMs: lease.metadata.videoDurationMs,
      ...(mutation.id ? { id: mutation.id } : {}),
      ...common,
    };
  } else {
    lowered = { kind: 'commit', ...common };
  }
  core.updateFieldSlot(ownerId, fieldDefId, lowered);
}

function requiredAssetLease(
  leaseId: string | undefined,
  assetLeases: Readonly<Record<string, AssetLease>>,
): AssetLease {
  if (!leaseId) throw new Error('Asset lease is required');
  const lease = assetLeases[leaseId];
  if (!lease) throw new Error(`Asset lease was not resolved: ${leaseId}`);
  return lease;
}

function executeFieldUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  ownerId: string,
  instruction: Extract<Extract<Change, { op: 'update' }>['changes'][number], { kind: 'field' }>,
): void {
  if (instruction.action === 'register-option') {
    core.registerCollectedOption(ownerId, instruction.name);
    return;
  }
  if (instruction.action === 'convert') {
    core.createInlineFieldAfterNode(ownerId, instruction.name, instruction.fieldType);
    return;
  }
  let fieldDefId: string;
  let value: string | number | boolean | null | undefined;
  if (instruction.action === 'define') {
    const owner = core.state().nodes[ownerId];
    const outcome = owner?.type === 'tagDef'
      ? core.createFieldDef(ownerId, instruction.name, instruction.fieldType)
      : core.createInlineField(ownerId, instruction.index ?? null, instruction.name, instruction.fieldType);
    const entryId = outcome.focus?.nodeId;
    if (!entryId || instruction.value === undefined) return;
    const createdFieldDefId = (core.state().nodes[entryId] as Extract<Node, { type: 'fieldEntry' }> | undefined)?.fieldDefId;
    if (!createdFieldDefId) throw new Error('field define did not create a field definition');
    fieldDefId = createdFieldDefId;
    value = instruction.value;
  } else {
    fieldDefId = exactlyOne(resolveFieldTargetRef(baseIndex, instruction.field, bindings), 'field definition');
    if (instruction.action === 'set') value = instruction.value;
  }
  if (instruction.action === 'attach') {
    if (fieldEntry(core, ownerId, fieldDefId)) return;
    core.createInlineField(ownerId, instruction.index ?? null, '', 'plain', fieldDefId);
    return;
  }
  const entry = fieldEntry(core, ownerId, fieldDefId);
  if (instruction.action === 'clear') {
    if (entry) core.clearFieldValue(entry.id);
  } else if (instruction.action === 'remove') {
    if (entry) core.deleteNode(entry.id);
  } else if (instruction.action === 'reuse') {
    const sourceFieldDefId = instruction.sourceField
      ? exactlyOne(resolveFieldTargetRef(baseIndex, instruction.sourceField, bindings), 'source field definition')
      : undefined;
    const sourceEntry = sourceFieldDefId ? fieldEntry(core, ownerId, sourceFieldDefId) : entry;
    if (!sourceEntry) throw new Error('field reuse requires an existing source field entry');
    core.reuseFieldDefinition(sourceEntry.id, fieldDefId);
  } else if (instruction.action === 'select') {
    if (!entry) throw new Error('field select requires an entry');
    const optionId = exactlyOne(resolveTargetRef(baseIndex, instruction.option, bindings), 'field option');
    core.selectFieldOption(entry.id, optionId);
  } else if (value !== undefined) {
    if (entry) {
      const state = core.state();
      const values = entry.children.map((id) => state.nodes[id]).filter(Boolean);
      if (values.length === 1 && values[0]?.content.text === fieldValueText(value)) return;
    }
    if (entry) core.clearFieldValue(entry.id);
    core.updateFieldSlot(ownerId, fieldDefId, {
      kind: 'appendNodes',
      nodes: [{ content: plainText(fieldValueText(value)), children: [] }],
    });
  }
}

function resolveFieldTargetRef(
  baseIndex: ReturnType<typeof createSelectionIndex>,
  reference: TargetRef,
  bindings: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  if (
    'target' in reference
    && reference.target.selector.by === 'id'
    && isSystemFieldId(reference.target.selector.id)
  ) {
    return [reference.target.selector.id];
  }
  return resolveTargetRef(baseIndex, reference, bindings);
}

function executeViewUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  targetId: string,
  instruction: Extract<Extract<Change, { op: 'update' }>['changes'][number], { kind: 'view' }>,
): void {
  if (instruction.property === 'configuration') {
    applyDeclarativeView(core, baseIndex, bindings, targetId, instruction.view);
  } else if (instruction.property === 'mode') {
    core.setViewMode(targetId, instruction.mode);
  } else if (instruction.property === 'toolbar') {
    core.setViewToolbarVisible(targetId, instruction.visible);
  } else if (instruction.property === 'group') {
    core.setGroupField(targetId, resolveViewField(baseIndex, bindings, instruction.field));
  } else if (instruction.property === 'sort') {
    if (instruction.action === 'add') core.addSortRule(
      targetId,
      resolveViewField(baseIndex, bindings, instruction.field)!,
      instruction.direction,
    );
    else if (instruction.action === 'set') core.updateSortRule(
      instruction.ruleId,
      resolveViewField(baseIndex, bindings, instruction.field)!,
      instruction.direction,
    );
    else if (instruction.action === 'remove') core.removeSortRule(instruction.ruleId);
    else core.clearSortRules(targetId);
  } else if (instruction.property === 'filter') {
    if (instruction.action === 'add') core.addFilterRule(
      targetId,
      resolveViewField(baseIndex, bindings, instruction.field)!,
      instruction.operator,
      instruction.values,
      instruction.valueLogic,
    );
    else if (instruction.action === 'set') core.updateFilterRule(instruction.ruleId, {
      ...(instruction.field !== undefined
        ? { field: resolveViewField(baseIndex, bindings, instruction.field) }
        : {}),
      ...(instruction.operator !== undefined ? { operator: instruction.operator } : {}),
      ...(instruction.values !== undefined ? { values: instruction.values } : {}),
      ...(instruction.valueLogic !== undefined ? { valueLogic: instruction.valueLogic } : {}),
    });
    else if (instruction.action === 'remove') core.removeFilterRule(instruction.ruleId);
    else core.clearFilterRules(targetId);
  } else if (instruction.action === 'add') {
    core.addDisplayField(targetId, resolveViewField(baseIndex, bindings, instruction.field)!);
  } else if (instruction.action === 'set') {
    core.updateDisplayField(instruction.displayFieldId, {
      ...(instruction.field !== undefined
        ? { field: resolveViewField(baseIndex, bindings, instruction.field) }
        : {}),
      ...(instruction.visible !== undefined ? { visible: instruction.visible } : {}),
      ...(instruction.width !== undefined ? { width: instruction.width } : {}),
      ...(instruction.order !== undefined ? { order: instruction.order } : {}),
      ...(instruction.label !== undefined ? { label: instruction.label } : {}),
      ...(instruction.placement !== undefined ? { placement: instruction.placement } : {}),
      ...(instruction.move !== undefined ? { move: instruction.move } : {}),
    });
  } else {
    core.removeDisplayField(instruction.displayFieldId);
  }
}

function applyDeclarativeView(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  targetId: string,
  view: Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
): void {
  const stateBefore = core.state();
  const owner = stateBefore.nodes[targetId];
  if (!owner) throw new Error(`View owner does not exist: ${targetId}`);
  const viewDef = owner.children.map((id) => stateBefore.nodes[id]).find((node) => node?.type === 'viewDef');
  if (view.mode !== undefined && viewDef?.viewMode !== view.mode) core.setViewMode(targetId, view.mode);
  if (view.toolbar !== undefined && viewDef?.toolbarVisible !== view.toolbar) core.setViewToolbarVisible(targetId, view.toolbar);
  if (view.group !== undefined) {
    const group = resolveViewField(baseIndex, bindings, view.group);
    if ((viewDef?.groupField ?? null) !== group) core.setGroupField(targetId, group);
  }
  if (!view.replace) return;

  const current = declarativeViewState(core, targetId);
  const expectedSort = view.replace.sort
    ? normalizeSortSpecifications(view.replace.sort, baseIndex, bindings)
    : undefined;
  if (expectedSort && canonicalJson(current.sort) !== canonicalJson(expectedSort)) {
    core.clearSortRules(targetId);
    for (const rule of expectedSort) core.addSortRule(targetId, rule.field, rule.direction);
  }
  const expectedFilters = view.replace.filters
    ? normalizeFilterSpecifications(view.replace.filters, baseIndex, bindings)
    : undefined;
  if (expectedFilters && canonicalJson(current.filters) !== canonicalJson(expectedFilters)) {
    core.clearFilterRules(targetId);
    for (const rule of expectedFilters) {
      core.addFilterRule(targetId, rule.field, rule.operator, rule.values, rule.valueLogic);
    }
  }
  const expectedDisplay = view.replace.display
    ? normalizeDisplaySpecifications(view.replace.display, baseIndex, bindings)
    : undefined;
  if (expectedDisplay && canonicalJson(current.display) !== canonicalJson(expectedDisplay)) {
    for (const display of current.nodes) core.removeDisplayField(display.id);
    for (const specification of expectedDisplay) {
      const outcome = core.addDisplayField(targetId, specification.field);
      const displayFieldId = outcome.focus?.nodeId;
      if (!displayFieldId) throw new Error('Core did not create a display field');
      core.updateDisplayField(displayFieldId, {
        visible: specification.visible,
        order: specification.order,
        ...(specification.width !== undefined ? { width: specification.width } : {}),
        ...(specification.label !== undefined ? { label: specification.label } : {}),
        ...(specification.placement !== undefined ? { placement: specification.placement } : {}),
      });
    }
  }
}

function declarativeViewState(core: Core, targetId: string) {
  const state = core.state();
  const owner = state.nodes[targetId];
  const viewDef = owner?.children.map((id) => state.nodes[id]).find((node) => node?.type === 'viewDef');
  const children = viewDef?.children.map((id) => state.nodes[id]) ?? [];
  const displayNodes = children.filter((node): node is Extract<Node, { type: 'displayField' }> => node?.type === 'displayField');
  return {
    sort: children.flatMap((node) => node?.type === 'sortRule' && node.sortField
      ? [{ field: node.sortField, direction: node.sortDirection ?? 'asc' }]
      : []),
    filters: children.flatMap((node) => node?.type === 'filterRule' && node.filterField
      ? [{
          field: node.filterField,
          operator: node.filterOperator ?? 'contains',
          values: node.filterValues ?? [],
          valueLogic: node.filterValueLogic ?? 'any',
        }]
      : []),
    display: displayNodes.map((node, index) => ({
      field: node.displayField!,
      visible: node.displayVisible ?? true,
      order: node.displayOrder ?? index,
      ...(node.displayWidth !== undefined ? { width: node.displayWidth } : {}),
      ...(node.displayLabel !== undefined ? { label: node.displayLabel } : {}),
      ...(node.displayPlacement !== undefined ? { placement: node.displayPlacement } : {}),
    })),
    nodes: displayNodes,
  };
}

function normalizeSortSpecifications(
  rules: readonly { field: ViewFieldRef | TargetRef; direction?: SortDirection }[],
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
) {
  return rules.map((rule) => ({
    field: resolveViewField(baseIndex, bindings, rule.field)!,
    direction: rule.direction ?? 'asc',
  }));
}

function normalizeFilterSpecifications(
  rules: readonly {
    field: ViewFieldRef | TargetRef;
    operator?: FilterOperator;
    values?: string[];
    valueLogic?: FilterValueLogic;
  }[],
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
) {
  return rules.map((rule) => ({
    field: resolveViewField(baseIndex, bindings, rule.field)!,
    operator: rule.operator ?? 'contains',
    values: rule.values ?? [],
    valueLogic: rule.valueLogic ?? 'any',
  }));
}

function normalizeDisplaySpecifications(
  fields: readonly {
    field: ViewFieldRef | TargetRef;
    visible?: boolean;
    width?: number;
    order?: number;
    label?: string | null;
    placement?: Extract<Node, { type: 'displayField' }>['displayPlacement'];
  }[],
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
) {
  return fields.map((field, index) => ({
    field: resolveViewField(baseIndex, bindings, field.field)!,
    visible: field.visible ?? true,
    order: field.order ?? index,
    ...(field.width !== undefined ? { width: field.width } : {}),
    ...(field.label !== undefined ? { label: field.label } : {}),
    ...(field.placement !== undefined ? { placement: field.placement } : {}),
  }));
}

function definitionPatchChanges(
  core: Core,
  targetId: string,
  instruction: Extract<UpdateInstruction, { kind: 'definition' }>,
): boolean {
  const config = buildConfigIndex(core.state());
  const current = instruction.definitionType === 'tag' ? config.tag(targetId) : config.field(targetId);
  if (!current) throw new Error(`Definition config is unavailable: ${targetId}`);
  for (const [key, value] of Object.entries(instruction.patch)) {
    let normalized: unknown = value;
    if (value === null) {
      if (key === 'nullable') normalized = true;
      else if (key === 'hideField') normalized = 'never';
      else normalized = undefined;
    }
    if (key === 'autoInitialize' && typeof value === 'string') {
      normalized = value.split(/[,+]/).map((entry) => entry.trim()).filter(Boolean);
    }
    if (canonicalJson((current as unknown as Record<string, unknown>)[key] ?? null) !== canonicalJson(normalized ?? null)) return true;
  }
  return false;
}

function resolveViewField(
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  field: ViewFieldRef | TargetRef | null,
): ViewFieldRef | null {
  if (field === null || typeof field === 'string') return field;
  return exactlyOne(resolveTargetRef(baseIndex, field, bindings), 'view field');
}

function isReviewedTextReplaceInstruction(instruction: UpdateInstruction): boolean {
  return instruction.kind === 'text-patch' && instruction.review?.destructive === 'replace';
}

function directCommitHash(changeSetHash: string): string {
  return canonicalSha256({
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.direct-commit',
    changeSetHash,
  });
}

function directCommitPayloadHash(input: ChangeSet): string {
  return canonicalSha256({
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.direct-commit-payload',
    changeSet: input,
  });
}

function assertDirectCommitIsNonDestructive(changeSet: ChangeSet): void {
  const destructive = changeSet.operations.flatMap((change) => {
    if (change.op === 'lifecycle' && change.action === 'purge') return [change.contents ? 'empty-trash' : 'purge'];
    if (change.op === 'merge') return ['merge'];
    if (change.op === 'update' && change.changes.some(isReviewedTextReplaceInstruction)) return ['replace'];
    return [];
  });
  if (destructive.length === 0) return;
  throw new OutlineContractError(outlineError(
    'confirmation_required',
    'confirmation',
    'Destructive ChangeSets must be previewed with outline diff and applied as an exact reviewed Diff.',
    { details: { destructive } },
  ));
}

function diffFromPatch(
  changeSet: ChangeSet,
  changeSetHash: string,
  bindings: Readonly<Record<string, readonly string[]>>,
  reviewedReplaceTargetIds: readonly string[],
  patch: readonly CoreTransactionNodePatch[],
): Diff {
  const affected = patch.map((entry) => ({
    id: entry.id,
    effect: patchEffect(entry),
    beforeDigest: semanticNodeDigest(entry.before),
    afterDigest: semanticNodeDigest(entry.after),
  }));
  const destructive: Diff['destructive'] = [];
  for (const change of changeSet.operations) {
    if (change.op === 'lifecycle' && change.action === 'purge') {
      destructive.push({ kind: change.contents ? 'empty-trash' : 'purge', targetCount: affected.length });
    }
    if (change.op === 'merge') destructive.push({ kind: 'merge', targetCount: affected.length });
  }
  const reviewedReplaceTargets = new Set(reviewedReplaceTargetIds);
  const reviewedReplaceCount = affected.filter((entry) => (
    entry.effect === 'update' && reviewedReplaceTargets.has(entry.id)
  )).length;
  if (reviewedReplaceCount > 0) {
    destructive.push({ kind: 'replace', targetCount: reviewedReplaceCount });
  }
  const withoutHash = {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.diff' as const,
    diffHash: '0'.repeat(64),
    changeSetHash,
    baseRevision: changeSet.base?.revision ?? 0,
    normalizedChangeSet: changeSet,
    bindings: Object.fromEntries(Object.entries(bindings).map(([name, ids]) => [name, [...ids]])),
    affected,
    destructive,
    warnings: [],
    resultEstimate: {
      nodeCount: affected.length,
      encodedBytes: Buffer.byteLength(canonicalJson({ bindings, affected, destructive })),
    },
  };
  return { ...withoutHash, diffHash: canonicalDiffHash(withoutHash) };
}

function patchEffect(entry: CoreTransactionNodePatch): Diff['affected'][number]['effect'] {
  if (!entry.before) return 'create';
  if (!entry.after) return 'purge';
  if (entry.before.parentId !== entry.after.parentId) {
    if (entry.after.parentId === TRASH_ID) return 'trash';
    if (entry.before.parentId === TRASH_ID) return 'restore';
    return 'move';
  }
  return 'update';
}

function normalizeDraftIds(draft: NodeDraft, seed: string, path: string): NodeDraft {
  const id = draft.id ?? deterministicPublicNodeId(seed, path);
  if (!isClientNodeId(id)) {
    throw usageError(`NodeDraft.id must be a node:<uuid> identifier: ${id}`);
  }
  return {
    ...draft,
    id,
    children: draft.children.map((child, index) => normalizeDraftIds(child, seed, `${path}:${index}`)),
    ...(draft.fields ? {
      fields: draft.fields.map((field, fieldIndex) => ({
        ...field,
        values: field.values.map((value, valueIndex) => normalizeDraftIds(
          value,
          seed,
          `${path}:field:${fieldIndex}:${valueIndex}`,
        )),
      })),
    } : {}),
  };
}

function changeTargetRefs(change: Change): readonly TargetRef[] {
  switch (change.op) {
    case 'resolve': return [{ target: change.target }];
    case 'ensure': {
      if (change.resource === 'tag-search') return [change.tag];
      if (change.resource === 'definition' && change.definitionType === 'tag' && change.extends) {
        return [change.extends];
      }
      return [];
    }
    case 'create': return 'resource' in change ? [] : placementTargetRefs(change.placement);
    case 'update': return [
      change.targets,
      ...change.changes.flatMap((instruction): TargetRef[] => {
        if (instruction.kind === 'tag') return [instruction.tag];
        if (instruction.kind === 'reference') return [instruction.target];
        if (instruction.kind === 'field') {
          return [
            'field' in instruction ? instruction.field : undefined,
            'sourceField' in instruction ? instruction.sourceField : undefined,
            'option' in instruction ? instruction.option : undefined,
          ].filter((value): value is TargetRef => Boolean(value));
        }
        if (instruction.kind === 'field-slot') {
          const refs: TargetRef[] = [instruction.field];
          if (instruction.mutation.action === 'append-reference') refs.push(instruction.mutation.target);
          if (instruction.mutation.action === 'select-option') refs.push(instruction.mutation.option);
          if (instruction.mutation.action === 'append-nodes') refs.push(...instruction.mutation.firstTags ?? []);
          return refs;
        }
        if (instruction.kind === 'view'
          && 'field' in instruction
          && instruction.field
          && typeof instruction.field === 'object') {
          return [instruction.field];
        }
        return [];
      }),
    ];
    case 'move': return [change.targets, ...placementTargetRefs(change.placement)];
    case 'duplicate': return [change.targets, ...placementTargetRefs(change.placement)];
    case 'merge': return [change.sources, change.target];
    case 'template': return [change.tag];
    case 'lifecycle': return [change.targets];
  }
}

function isVirtualSystemFieldTarget(change: Change, reference: TargetRef): boolean {
  if (
    'binding' in reference
    || reference.target.selector.by !== 'id'
    || !isSystemFieldId(reference.target.selector.id)
    || change.op !== 'update'
  ) {
    return false;
  }
  return change.changes.some((instruction) => (
    instruction.kind === 'field'
    && (
      ('field' in instruction && instruction.field === reference)
      || ('sourceField' in instruction && instruction.sourceField === reference)
    )
  ));
}

function changeBinding(change: Change): string | undefined {
  return change.op === 'resolve' || change.op === 'ensure' || change.op === 'create' || change.op === 'duplicate'
    ? change.bind
    : undefined;
}

function addExpectedNode(node: NodeProjection | undefined, expected: Map<string, string>): void {
  if (!node) return;
  const digest = semanticNodeDigest(node);
  if (digest) expected.set(node.id, digest);
}

function fieldEntry(core: Core, ownerId: string, fieldDefId: string): Extract<Node, { type: 'fieldEntry' }> | undefined {
  const state = core.state();
  return state.nodes[ownerId]?.children
    .map((nodeId) => state.nodes[nodeId])
    .find((node): node is Extract<Node, { type: 'fieldEntry' }> => (
      node?.type === 'fieldEntry' && node.fieldDefId === fieldDefId
    ));
}

function toCoreTree(draft: NodeDraft): CreateNodeTree {
  const metadata = isRecord(draft.metadata) ? draft.metadata : {};
  return {
    content: draft.content,
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.type === 'codeBlock' ? { type: 'codeBlock' as const, codeLanguage: draft.codeLanguage } : {}),
    ...(draft.checkbox ? { checkbox: true, done: draft.done === true } : {}),
    ...(Array.isArray(metadata.pasteTags) ? { tags: metadata.pasteTags.filter((tag): tag is string => typeof tag === 'string') } : {}),
    ...(Array.isArray(metadata.pasteFields) ? {
      fields: metadata.pasteFields.filter((field): field is { name: string; value: string } => (
        isRecord(field) && typeof field.name === 'string' && typeof field.value === 'string'
      )).map((field) => ({ name: field.name, value: field.value })),
    } : {}),
    children: draft.children.map(toCoreTree),
  };
}

function fieldValueText(value: unknown): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid local date: ${value}`);
  }
  return { year, month, day };
}

function exactlyOne(ids: readonly string[], label: string): string {
  if (ids.length !== 1) throw new Error(`${label} must resolve to exactly one Node; received ${ids.length}`);
  return ids[0]!;
}

function summarizeChangeSet(changeSet: ChangeSet): string {
  const counts = new Map<Change['op'], number>();
  for (const change of changeSet.operations) {
    counts.set(change.op, (counts.get(change.op) ?? 0) + 1);
  }
  const summary = [...counts].map(([name, count]) => count === 1 ? name : `${name} x${count}`).join(', ');
  return `Applied ${changeSet.operations.length} ChangeSet operation${changeSet.operations.length === 1 ? '' : 's'}: ${summary}.`;
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
