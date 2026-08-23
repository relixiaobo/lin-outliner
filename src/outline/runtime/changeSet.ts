import { Value } from 'typebox/value';
import type { Core, CoreTransactionNodePatch } from '../../core/core';
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
  ChangeSetSchema,
  DiffSchema,
  type Change,
  type ChangeSet,
  type Diff,
  type NodeDraft,
  type Operation,
  type TargetRef,
} from '../contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';
import { createDeterministicCoreIdFactory, deterministicPublicNodeId } from './deterministicIds';
import { projectOutline, resolveTargetRef } from './projection';
import { semanticAffectedDigest, semanticNodeDigest } from './semanticDigest';
import { createSelectionIndex, resolveTargetSpec } from './selector';
import type { OutlineRuntimeRequestContext } from './server/runtimeRouter';
import type { OutlineRuntimeWorkspace } from './runtimeWorkspace';
import type { CaptureNodeMetadata } from '../../core/launcher/sources';

interface ExecuteResult {
  readonly bindings: Readonly<Record<string, readonly string[]>>;
}

export async function diffOutlineChangeSet(
  workspace: OutlineRuntimeWorkspace,
  input: ChangeSet,
): Promise<Diff> {
  const normalized = normalizeOutlineChangeSet(workspace.forkCore(), input);
  const changeSetHash = canonicalChangeSetHash(normalized);
  const candidate = workspace.forkCore({ idFactory: createDeterministicCoreIdFactory(changeSetHash) });
  let execution: ExecuteResult = { bindings: {} };
  const { patch } = await candidate.transactionWithPatch('user', async () => {
    execution = await executeOutlineChangeSet(candidate, normalized);
  }, { operationId: `preview:${changeSetHash}`, command: 'outline_diff' });
  return diffFromPatch(normalized, changeSetHash, execution.bindings, patch.nodes);
}

export async function applyOutlineDiff(
  workspace: OutlineRuntimeWorkspace,
  diff: Diff,
  context: OutlineRuntimeRequestContext,
  acknowledgeDestructive = false,
): Promise<Operation> {
  if (!Value.Check(DiffSchema, diff)) throw usageError('Invalid outline Diff artifact.');
  const actualDiffHash = canonicalDiffHash(diff);
  if (actualDiffHash !== diff.diffHash) {
    throw new OutlineContractError(outlineError('diff_mismatch', 'conflict', 'Diff hash does not match its content.'));
  }
  if (canonicalChangeSetHash(diff.normalizedChangeSet) !== diff.changeSetHash) {
    throw new OutlineContractError(outlineError('diff_mismatch', 'conflict', 'ChangeSet hash does not match the Diff.'));
  }
  assertBaseState(workspace.forkCore(), diff.normalizedChangeSet);
  if (diff.destructive.length > 0 && !acknowledgeDestructive) {
    throw new OutlineContractError(outlineError(
      'confirmation_required',
      'confirmation',
      'This Diff contains destructive changes and requires acknowledgement.',
      { details: diff.destructive },
    ));
  }

  let execution: ExecuteResult = { bindings: {} };
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
    execute: async (candidate) => {
      execution = await executeOutlineChangeSet(candidate, diff.normalizedChangeSet);
    },
    ...(diff.normalizedChangeSet.return ? {
      result: (candidate: Core) => diff.normalizedChangeSet.return!.map((projection) => (
        projectOutline(candidate, projection, execution.bindings)
      )),
    } : {}),
  });
}

export function normalizeOutlineChangeSet(core: Core, input: ChangeSet): ChangeSet {
  if (!Value.Check(ChangeSetSchema, input)) throw usageError('Input does not match the public ChangeSet schema.');
  if (input.base?.revision !== undefined && input.base.revision !== core.revision()) {
    throw new OutlineContractError(outlineError(
      'stale_revision',
      'conflict',
      `ChangeSet revision ${input.base.revision} does not match Runtime revision ${core.revision()}.`,
    ));
  }
  const normalized = clone(input);
  const publicIdSeed = canonicalSha256(input);
  normalized.operations = normalized.operations.map((change, operationIndex) => {
    if (change.op !== 'create') return change;
    return {
      ...change,
      nodes: change.nodes.map((draft, nodeIndex) => normalizeDraftIds(
        draft,
        publicIdSeed,
        `${operationIndex}:${nodeIndex}`,
      )),
    };
  });

  const index = createSelectionIndex(core.projection());
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
    revision: core.revision(),
    nodes: Object.fromEntries([...expected].sort(([left], [right]) => compareText(left, right))),
  };
  return normalized;
}

export async function executeOutlineChangeSet(core: Core, changeSet: ChangeSet): Promise<ExecuteResult> {
  const baseIndex = createSelectionIndex(core.projection());
  const bindings: Record<string, readonly string[]> = {};
  for (const [operationIndex, change] of changeSet.operations.entries()) {
    try {
      const result = await executeChange(core, baseIndex, bindings, change, operationIndex);
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
  return { bindings: Object.freeze({ ...bindings }) };
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
): Promise<readonly string[]> {
  switch (change.op) {
    case 'resolve': return resolveTargetSpec(baseIndex, change.target);
    case 'ensure': return executeEnsure(core, baseIndex, bindings, change);
    case 'create': {
      const parentIds = resolveTargetRef(baseIndex, change.parents, bindings);
      const created: string[] = [];
      for (const [parentIndex, parentId] of parentIds.entries()) {
        for (const [draftIndex, draft] of change.nodes.entries()) {
          const copyPath = `${operationIndex}:${parentIndex}:${draftIndex}`;
          created.push(createDraft(core, parentId, change.index, draft, copyPath, parentIndex === 0));
        }
      }
      return created;
    }
    case 'update': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      for (const targetId of targetIds) {
        for (const instruction of change.changes) executeUpdate(core, baseIndex, bindings, targetId, instruction);
      }
      return targetIds;
    }
    case 'move': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      const destinationId = exactlyOne(resolveTargetRef(baseIndex, change.destination, bindings), 'move destination');
      for (const [index, targetId] of targetIds.entries()) {
        core.moveNode(targetId, destinationId, change.index == null ? change.index : change.index + index);
      }
      return targetIds;
    }
    case 'duplicate': {
      const targetIds = resolveTargetRef(baseIndex, change.targets, bindings);
      const destinationId = exactlyOne(resolveTargetRef(baseIndex, change.destination, bindings), 'duplicate destination');
      const created: string[] = [];
      for (const [index, targetId] of targetIds.entries()) {
        const duplicateId = core.batchDuplicateNodes([targetId]).focus?.nodeId;
        if (!duplicateId) throw new Error(`Core did not return the duplicate root for ${targetId}`);
        core.moveNode(duplicateId, destinationId, change.index == null ? change.index : change.index + index);
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
  if (existing) return [existing.id];
  const outcome = change.definitionType === 'tag'
    ? core.createTag(change.name)
    : core.createFieldDefinition(change.name, (change.fieldType ?? 'plain') as FieldType);
  if (!outcome.focus?.nodeId) throw new Error(`Core did not create definition: ${change.name}`);
  return [outcome.focus.nodeId];
}

function createDraft(
  core: Core,
  parentId: string,
  index: number | null | undefined,
  draft: NodeDraft,
  copyPath: string,
  preserveId: boolean,
): string {
  const id = preserveId ? draft.id! : deterministicPublicNodeId(draft.id!, copyPath);
  const metadata = isRecord(draft.metadata) ? draft.metadata : {};
  if (isRecord(metadata.capture)) {
    assertCaptureMetadata(metadata.capture);
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
    core.createImageNode(parentId, index, {
      ...(draft.assetLeaseId ? { assetId: draft.assetLeaseId } : {}),
      ...(draft.mediaUrl ? { mediaUrl: draft.mediaUrl } : {}),
      ...(typeof metadata.width === 'number' ? { width: metadata.width } : {}),
      ...(typeof metadata.height === 'number' ? { height: metadata.height } : {}),
      name: draft.content.text,
    }, id);
  } else if (draft.type === 'attachment') {
    core.createAttachmentNode(parentId, index, {
      assetId: draft.assetLeaseId,
      mimeType: typeof metadata.mimeType === 'string' ? metadata.mimeType : undefined,
      originalFilename: typeof metadata.originalFilename === 'string' ? metadata.originalFilename : draft.content.text,
      fileSize: typeof metadata.fileSize === 'number' ? metadata.fileSize : undefined,
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
    createDraft(core, id, null, child, `${copyPath}:${childIndex}`, preserveId);
  }
  return id;
}

function executeUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  targetId: string,
  instruction: Extract<Change, { op: 'update' }>['changes'][number],
): void {
  if (instruction.kind === 'content') {
    core.applyNodeTextPatch(targetId, { ops: [{ type: 'replace_all', content: instruction.value }] });
  } else if (instruction.kind === 'description') {
    core.updateNodeDescription(targetId, instruction.value);
  } else if (instruction.kind === 'text-patch') {
    core.applyNodeTextPatch(targetId, {
      ops: [{ type: 'replace', from: instruction.from, to: instruction.to, content: plainText(instruction.value) }],
    });
  } else if (instruction.kind === 'code') {
    const node = core.state().nodes[targetId];
    if (node?.type === 'codeBlock') core.setCodeLanguage(targetId, instruction.language);
    else core.setCodeBlock(targetId, instruction.language);
  } else if (instruction.kind === 'checkbox') {
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
  } else if (instruction.kind === 'definition') {
    if (!isRecord(instruction.patch)) throw new Error('definition configure requires an object patch');
    if (instruction.definitionType === 'tag') core.setTagConfig(targetId, instruction.patch as TagConfigPatch);
    else core.setFieldConfig(targetId, instruction.patch as FieldConfigPatch);
  } else if (instruction.kind === 'reference') {
    const referenceTargetId = exactlyOne(resolveTargetRef(baseIndex, instruction.target, bindings), 'reference target');
    if (instruction.action === 'add') core.addReference(targetId, referenceTargetId);
    else if (instruction.action === 'retarget') core.setReferenceTarget(targetId, referenceTargetId);
    else if (instruction.action === 'inline') core.convertReferenceToInlineNode(targetId);
    else core.restoreInlineReferenceNodeToReference(targetId, referenceTargetId);
  } else if (instruction.kind === 'view') {
    executeViewUpdate(core, targetId, instruction);
  } else if (instruction.kind === 'search') {
    if (instruction.action === 'refresh') core.refreshSearchNodeResults(targetId);
    else {
      if (!isRecord(instruction.value)) throw new Error('search set requires a config object');
      core.setSearchNode(targetId, instruction.value as unknown as SearchNodeConfig);
    }
  } else if (instruction.kind === 'icon') {
    core.setNodeIcon(targetId, instruction.value, instruction.iconKind as Parameters<Core['setNodeIcon']>[2]);
  } else if (instruction.kind === 'banner') {
    core.setNodeBanner(targetId, instruction.assetLeaseId, instruction.position);
  } else {
    core.setNodeImage(targetId, {
      ...(instruction.assetLeaseId ? { assetId: instruction.assetLeaseId } : {}),
      ...(instruction.mediaUrl ? { mediaUrl: instruction.mediaUrl } : {}),
      width: instruction.width,
      height: instruction.height,
    });
  }
}

function executeFieldUpdate(
  core: Core,
  baseIndex: ReturnType<typeof createSelectionIndex>,
  bindings: Readonly<Record<string, readonly string[]>>,
  ownerId: string,
  instruction: Extract<Extract<Change, { op: 'update' }>['changes'][number], { kind: 'field' }>,
): void {
  let fieldDefId = instruction.field
    ? exactlyOne(resolveTargetRef(baseIndex, instruction.field, bindings), 'field definition')
    : undefined;
  if (instruction.action === 'define') {
    if (!instruction.name) throw new Error('field define requires name');
    const owner = core.state().nodes[ownerId];
    const outcome = owner?.type === 'tagDef'
      ? core.createFieldDef(ownerId, instruction.name, (instruction.fieldType ?? 'plain') as FieldType)
      : core.createInlineField(ownerId, null, instruction.name, (instruction.fieldType ?? 'plain') as FieldType);
    const entryId = outcome.focus?.nodeId;
    if (!entryId || instruction.value === undefined) return;
    fieldDefId = (core.state().nodes[entryId] as Extract<Node, { type: 'fieldEntry' }> | undefined)?.fieldDefId;
  }
  if (!fieldDefId) throw new Error(`field ${instruction.action} requires a field definition`);
  const entry = fieldEntry(core, ownerId, fieldDefId);
  if (instruction.action === 'clear') {
    if (entry) core.clearFieldValue(entry.id);
  } else if (instruction.action === 'remove') {
    if (entry) core.deleteNode(entry.id);
  } else if (instruction.action === 'reuse') {
    const sourceFieldDefId = instruction.sourceField
      ? exactlyOne(resolveTargetRef(baseIndex, instruction.sourceField, bindings), 'source field definition')
      : undefined;
    const sourceEntry = sourceFieldDefId ? fieldEntry(core, ownerId, sourceFieldDefId) : entry;
    if (!sourceEntry) throw new Error('field reuse requires an existing source field entry');
    core.reuseFieldDefinition(sourceEntry.id, fieldDefId);
  } else if (instruction.action === 'select') {
    if (!entry || typeof instruction.value !== 'string') throw new Error('field select requires an entry and option Node ID');
    core.selectFieldOption(entry.id, instruction.value);
  } else if (instruction.value !== undefined) {
    if (entry) core.clearFieldValue(entry.id);
    core.updateFieldSlot(ownerId, fieldDefId, {
      kind: 'appendNodes',
      nodes: [{ content: plainText(fieldValueText(instruction.value)), children: [] }],
    });
  }
}

function executeViewUpdate(
  core: Core,
  targetId: string,
  instruction: Extract<Extract<Change, { op: 'update' }>['changes'][number], { kind: 'view' }>,
): void {
  const value = isRecord(instruction.value) ? instruction.value : {};
  if (instruction.property === 'mode') {
    const mode = typeof instruction.value === 'string' ? instruction.value : value.mode;
    core.setViewMode(targetId, mode as ViewMode);
  } else if (instruction.property === 'toolbar') {
    const visible = typeof instruction.value === 'boolean' ? instruction.value : value.visible;
    core.setViewToolbarVisible(targetId, visible === true);
  } else if (instruction.property === 'group') {
    core.setGroupField(targetId, (typeof instruction.value === 'string' ? instruction.value : value.field) as ViewFieldRef);
  } else if (instruction.property === 'sort') {
    if (instruction.action === 'add') core.addSortRule(targetId, String(value.field) as ViewFieldRef, value.direction as SortDirection);
    else if (instruction.action === 'set') core.updateSortRule(String(value.ruleId), String(value.field) as ViewFieldRef, value.direction as SortDirection);
    else if (instruction.action === 'remove') core.removeSortRule(String(value.ruleId));
    else core.clearSortRules(targetId);
  } else if (instruction.property === 'filter') {
    if (instruction.action === 'add') core.addFilterRule(
      targetId,
      String(value.field) as ViewFieldRef,
      value.operator as FilterOperator,
      Array.isArray(value.values) ? value.values.map(String) : [],
      value.valueLogic as FilterValueLogic,
    );
    else if (instruction.action === 'set') core.updateFilterRule(String(value.ruleId), value);
    else if (instruction.action === 'remove') core.removeFilterRule(String(value.ruleId));
    else core.clearFilterRules(targetId);
  } else if (instruction.action === 'add') {
    core.addDisplayField(targetId, String(value.field) as ViewFieldRef);
  } else if (instruction.action === 'set') {
    core.updateDisplayField(String(value.displayFieldId), value);
  } else {
    core.removeDisplayField(String(value.displayFieldId));
  }
}

function diffFromPatch(
  changeSet: ChangeSet,
  changeSetHash: string,
  bindings: Readonly<Record<string, readonly string[]>>,
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
  if (!/^node:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
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
    case 'ensure': return change.resource === 'tag-search' ? [change.tag] : [];
    case 'create': return [change.parents];
    case 'update': return [
      change.targets,
      ...change.changes.flatMap((instruction): TargetRef[] => {
        if (instruction.kind === 'tag') return [instruction.tag];
        if (instruction.kind === 'reference') return [instruction.target];
        if (instruction.kind === 'field') return [instruction.field, instruction.sourceField].filter((value): value is TargetRef => Boolean(value));
        return [];
      }),
    ];
    case 'move': return [change.targets, change.destination];
    case 'duplicate': return [change.targets, change.destination];
    case 'merge': return [change.sources, change.target];
    case 'template': return [change.tag];
    case 'lifecycle': return [change.targets];
  }
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
  return {
    content: draft.content,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.type === 'codeBlock' ? { type: 'codeBlock' as const, codeLanguage: draft.codeLanguage } : {}),
    ...(draft.checkbox ? { checkbox: true, done: draft.done === true } : {}),
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

function assertCaptureMetadata(value: Record<string, unknown>): asserts value is Record<string, unknown> & CaptureNodeMetadata {
  if (value.schemaVersion !== 1
    || typeof value.captureId !== 'string'
    || !['launcher', 'agent', 'import'].includes(String(value.createdBy))
    || typeof value.capturedAt !== 'string'
    || typeof value.providerId !== 'string'
    || !isRecord(value.app)
    || !isRecord(value.source)
    || !Array.isArray(value.warnings)) {
    throw new Error('NodeDraft metadata.capture is not valid capture provenance');
  }
}

function exactlyOne(ids: readonly string[], label: string): string {
  if (ids.length !== 1) throw new Error(`${label} must resolve to exactly one Node; received ${ids.length}`);
  return ids[0]!;
}

function summarizeChangeSet(changeSet: ChangeSet): string {
  const names = changeSet.operations.map((change) => change.op);
  return `Applied ${changeSet.operations.length} ChangeSet operation${changeSet.operations.length === 1 ? '' : 's'}: ${names.join(', ')}.`;
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
