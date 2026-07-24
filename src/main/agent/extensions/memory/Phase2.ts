import {
  decodeMemoryConsolidationOutput,
  memoryTagId,
  type MemoryConsolidationChange,
  type MemoryConsolidationNode,
  type MemoryConsolidationOutput,
} from '../../../../core/agent/memory';
import type { Thread } from '../../../../core/agent/protocol';
import type { DocumentProjection } from '../../../../core/types';
import { freshNodeId } from '../../../../core/nodeId';
import { uuidV7 } from '../../uuid';
import {
  MemoryControlStore,
  type MemoryGeneratedNodeRecord,
  type MemoryLineageInput,
  type MemoryPublicationRecord,
} from './MemoryControlStore';
import type { MemoryModelRunner } from './Phase1';
import {
  TimelineMemoryStore,
  memoryNodeFingerprint,
  timelineDigest,
  timelineNodeFingerprint,
  timelineSubtreeFingerprint,
  type CanonicalMemoryNode,
  type TimelineConsolidationChange,
} from './TimelineMemoryStore';

const MAX_SELECTED_NODES = 240;
const GENERATED_UNUSED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

interface ConsolidationPublicationPayload {
  readonly inputFingerprints: Readonly<Record<string, string>>;
  readonly deletionSubtreeFingerprints: Readonly<Record<string, string>>;
  readonly changes: readonly TimelineConsolidationChange[];
  readonly upsertedNodes: readonly MemoryGeneratedNodeRecord[];
  readonly lineage: readonly MemoryLineageInput[];
  readonly releasedNodeIds: readonly string[];
  readonly rollbackIds: readonly string[];
  readonly reconciledRollbackIds: readonly string[];
  readonly needsFollowUp: boolean;
}

interface PreparedConsolidation {
  readonly changes: readonly TimelineConsolidationChange[];
  readonly upsertedNodes: readonly MemoryGeneratedNodeRecord[];
  readonly lineage: readonly MemoryLineageInput[];
  readonly releasedNodeIds: readonly string[];
  readonly reconciledRollbackIds: readonly string[];
  readonly needsFollowUp: boolean;
}

export class Phase2 {
  constructor(
    private readonly control: MemoryControlStore,
    private readonly timeline: TimelineMemoryStore,
    private readonly model: MemoryModelRunner,
    private readonly internalThread: () => Thread | null,
  ) {}

  async run(signal: AbortSignal): Promise<'published' | 'unchanged' | 'disabled'> {
    const status = this.control.status();
    if (status.featureMode !== 'enabled') return 'disabled';
    const selected = this.selectInputs();
    const hasUnsupported = selected.some((node) => node.generated && node.supportingOriginItemIds.length === 0);
    const activeRollbacks = this.control.activeRollbacks();
    if (activeRollbacks.some((rollback) => rollback.status === 'prepared')) return 'unchanged';
    const rollbackIds = activeRollbacks.map((rollback) => rollback.rollbackId);
    const mustReconcileRollback = activeRollbacks.some((rollback) => rollback.status === 'committed');
    if (selected.length === 0 && !mustReconcileRollback) {
      this.control.recordSuccess();
      return 'unchanged';
    }
    const modelChanges = selected.length === 0
      ? []
      : await this.consolidate(selected, signal);
    if (modelChanges.every((change) => change.action === 'keep') && !mustReconcileRollback && !hasUnsupported) {
      this.control.recordSuccess();
      return 'unchanged';
    }

    await this.timeline.withWriteGate(async () => {
      validateConsolidationInputs(
        this.control,
        this.timeline,
        selected,
        rollbackIds,
        status.featureModeGeneration,
        status.resetEpoch,
        signal,
      );
      const operationId = `memory:stage2:${uuidV7()}`;
      const generation = this.control.allocatePublicationGeneration();
      const prepared = prepareConsolidation(modelChanges, selected, this.timeline, this.control);
      const projection = this.timeline.projection();
      const deletionSubtreeFingerprints = Object.fromEntries(prepared.changes.flatMap((change) => {
        if (change.action !== 'delete') return [];
        const fingerprint = timelineSubtreeFingerprint(change.nodeId, projection);
        if (!fingerprint) throw new Error(`Memory deletion target disappeared during preparation: ${change.nodeId}`);
        return [[change.nodeId, fingerprint]];
      }));
      const payload: ConsolidationPublicationPayload = {
        inputFingerprints: Object.fromEntries(selected.map((entry) => [entry.nodeId, entry.fingerprint])),
        deletionSubtreeFingerprints,
        changes: prepared.changes,
        upsertedNodes: prepared.upsertedNodes,
        lineage: prepared.lineage,
        releasedNodeIds: prepared.releasedNodeIds,
        rollbackIds,
        reconciledRollbackIds: prepared.reconciledRollbackIds,
        needsFollowUp: prepared.needsFollowUp,
      };
      const digest = timelineDigest({ operationId, generation, payload });
      const journal: MemoryPublicationRecord<ConsolidationPublicationPayload> = {
        id: operationId,
        kind: 'stage2',
        status: 'prepared',
        generation,
        featureGeneration: status.featureModeGeneration,
        resetEpoch: status.resetEpoch,
        digest,
        payload,
        createdAt: Date.now(),
      };
      this.control.preparePublication(journal);
      await this.publishPreparedWithinWriteGate(journal, signal);
    });
    return 'published';
  }

  private async consolidate(
    selected: readonly MemoryConsolidationNode[],
    signal: AbortSignal,
  ): Promise<MemoryConsolidationOutput['changes']> {
    const sourceThread = this.internalThread();
    if (!sourceThread) return [];
    const raw = await this.model.run({
      purpose: 'consolidate',
      sourceThread,
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: consolidationPrompt(selected),
      signal,
    });
    if (signal.aborted) throw abortError();
    const output = decodeMemoryConsolidationOutput(parseJsonObject(raw));
    return validateChanges(output, selected);
  }

  async recoverPrepared(record: MemoryPublicationRecord, receiptMatches: boolean): Promise<void> {
    if (record.kind !== 'stage2' || record.status !== 'prepared' || !receiptMatches) return;
    await this.timeline.withWriteGate(async () => this.finalize(
      record as MemoryPublicationRecord<ConsolidationPublicationPayload>,
    ));
  }

  private selectInputs(): readonly MemoryConsolidationNode[] {
    const graph = this.timeline.graph();
    const generated = new Map(this.control.generatedNodes().map((entry) => [entry.nodeId, entry]));
    const unsupported = new Set(this.control.generatedNodeIdsWithoutCurrentSupport());
    const projection = this.timeline.projection();
    const now = Date.now();
    const nodes: Array<MemoryConsolidationNode & {
      rankUnsupported: number;
      rankDepth: number;
      rankUsage: number;
      rankTime: number;
    }> = [];
    for (const entry of graph.nodes) {
      const generatedRecord = generated.get(entry.node.id);
      const fingerprint = timelineNodeFingerprint(entry);
      if (generatedRecord && generatedRecord.fingerprint !== fingerprint) {
        this.control.markNodeUserAuthoritative(entry.node.id);
      }
      const userAuthoritative = !generatedRecord
        || generatedRecord.userAuthoritative
        || generatedRecord.fingerprint !== fingerprint;
      const usage = this.control.usageForNode(entry.node.id);
      const supportingOriginItemIds = this.control.lineageForNode(entry.node.id)
        .filter((edge) => this.control.isOriginClaimed(edge.originItemId))
        .map((edge) => edge.originItemId);
      if (
        !userAuthoritative
        && supportingOriginItemIds.length > 0
        && usage.lastUsage === null
        && now - (generatedRecord?.generatedAt ?? now) > GENERATED_UNUSED_RETENTION_MS
      ) continue;
      nodes.push({
        nodeId: entry.node.id,
        parentId: entry.node.parentId ?? null,
        category: entry.category,
        sourceDate: entry.sourceDate,
        text: entry.node.content.text,
        generated: !userAuthoritative,
        fingerprint,
        supportingOriginItemIds,
        rankUnsupported: unsupported.has(entry.node.id) ? 1 : 0,
        rankDepth: nodeDepth(entry.node.id, projection),
        rankUsage: usage.count,
        rankTime: usage.lastUsage ?? generatedRecord?.generatedAt ?? entry.node.updatedAt,
      });
    }
    return nodes
      .sort((left, right) => right.rankUnsupported - left.rankUnsupported
        || right.rankDepth - left.rankDepth
        || right.rankUsage - left.rankUsage
        || right.rankTime - left.rankTime
        || left.nodeId.localeCompare(right.nodeId))
      .slice(0, MAX_SELECTED_NODES)
      .map(({
        rankUnsupported: _rankUnsupported,
        rankDepth: _rankDepth,
        rankUsage: _rankUsage,
        rankTime: _rankTime,
        ...node
      }) => node);
  }

  private async publishPreparedWithinWriteGate(
    journal: MemoryPublicationRecord<ConsolidationPublicationPayload>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.timeline.applyConsolidationWithinWriteGate(
      journal.id,
      journal.generation,
      journal.digest,
      journal.payload.changes,
      () => validatePreparedConsolidation(this.control, this.timeline, journal, signal),
    );
    this.finalize(journal);
  }

  private finalize(journal: MemoryPublicationRecord<ConsolidationPublicationPayload>): void {
    this.control.finalizeStage2({
      publicationId: journal.id,
      deletedNodeIds: journal.payload.changes
        .filter((change) => change.action === 'delete')
        .map((change) => change.nodeId),
      upsertedNodes: journal.payload.upsertedNodes,
      lineage: journal.payload.lineage,
      releasedNodeIds: journal.payload.releasedNodeIds,
      reconciledRollbackIds: journal.payload.reconciledRollbackIds,
      needsFollowUp: journal.payload.needsFollowUp,
    });
  }
}

function validateConsolidationInputs(
  control: MemoryControlStore,
  timeline: TimelineMemoryStore,
  selected: readonly MemoryConsolidationNode[],
  rollbackIds: readonly string[],
  featureGeneration: number,
  resetEpoch: number,
  signal: AbortSignal,
): void {
  validateConsolidationState(
    control,
    timeline,
    Object.fromEntries(selected.map((entry) => [entry.nodeId, entry.fingerprint])),
    rollbackIds,
    featureGeneration,
    resetEpoch,
    signal,
  );
}

function validatePreparedConsolidation(
  control: MemoryControlStore,
  timeline: TimelineMemoryStore,
  journal: MemoryPublicationRecord<ConsolidationPublicationPayload>,
  signal: AbortSignal,
): void {
  validateConsolidationState(
    control,
    timeline,
    journal.payload.inputFingerprints,
    journal.payload.rollbackIds,
    journal.featureGeneration,
    journal.resetEpoch,
    signal,
  );
  const projection = timeline.projection();
  for (const [nodeId, fingerprint] of Object.entries(journal.payload.deletionSubtreeFingerprints)) {
    if (timelineSubtreeFingerprint(nodeId, projection) !== fingerprint) {
      throw new Error(`Memory deletion subtree changed during consolidation: ${nodeId}`);
    }
  }
}

function validateConsolidationState(
  control: MemoryControlStore,
  timeline: TimelineMemoryStore,
  inputFingerprints: Readonly<Record<string, string>>,
  rollbackIds: readonly string[],
  featureGeneration: number,
  resetEpoch: number,
  signal: AbortSignal,
): void {
  const status = control.status();
  if (
    signal.aborted
    || status.featureMode !== 'enabled'
    || status.featureModeGeneration !== featureGeneration
    || status.resetEpoch !== resetEpoch
  ) throw abortError();
  const currentRollbackIds = control.activeRollbacks().map((rollback) => rollback.rollbackId);
  if (!sameStrings(currentRollbackIds, rollbackIds)) {
    throw new Error('Memory rollback state changed during consolidation');
  }
  const graph = timeline.graph();
  const current = new Map(graph.nodes.map((entry) => [entry.node.id, timelineNodeFingerprint(entry)]));
  for (const [nodeId, fingerprint] of Object.entries(inputFingerprints)) {
    if (current.get(nodeId) !== fingerprint) throw new Error(`Memory Node changed during consolidation: ${nodeId}`);
  }
}

function validateChanges(
  output: MemoryConsolidationOutput,
  selected: readonly MemoryConsolidationNode[],
): MemoryConsolidationOutput['changes'] {
  const selectedById = new Map(selected.map((entry) => [entry.nodeId, entry]));
  const changes = new Map(output.changes.flatMap((entry) => (
    entry.action === 'create' ? [] : [[entry.nodeId, entry] as const]
  )));
  for (const change of output.changes) {
    if (change.action === 'create') continue;
    const node = selectedById.get(change.nodeId);
    if (!node) throw new Error(`Memory consolidation targeted an unselected Node: ${change.nodeId}`);
    if (!node.generated && change.action !== 'keep') {
      throw new Error(`Memory consolidation cannot change user-authoritative Node: ${change.nodeId}`);
    }
    if (change.action === 'update') {
      for (const sourceNodeId of change.sourceNodeIds) {
        if (!selectedById.has(sourceNodeId)) {
          throw new Error(`Memory consolidation update cites an unselected source Node: ${sourceNodeId}`);
        }
      }
    }
  }
  return [
    ...selected.map((node) => changes.get(node.nodeId) ?? { nodeId: node.nodeId, action: 'keep' as const }),
    ...output.changes.filter((change) => change.action === 'create'),
  ];
}

function prepareConsolidation(
  changes: readonly MemoryConsolidationChange[],
  selected: readonly MemoryConsolidationNode[],
  timeline: TimelineMemoryStore,
  control: MemoryControlStore,
): PreparedConsolidation {
  const graph = timeline.graph();
  const entries = new Map(graph.nodes.map((entry) => [entry.node.id, entry]));
  const selectedById = new Map(selected.map((entry) => [entry.nodeId, entry]));
  const generated = new Map(control.generatedNodes().map((entry) => [entry.nodeId, entry]));
  const existingChanges = new Map(changes.flatMap((change) => (
    change.action === 'create' ? [] : [[change.nodeId, change] as const]
  )));
  const temporaryIds = new Map(changes.flatMap((change) => (
    change.action === 'create' ? [[change.temporaryId, freshNodeId()] as const] : []
  )));
  const createdEntries = new Map<string, {
    readonly nodeId: string;
    readonly parentId: string;
    readonly category: Exclude<MemoryConsolidationNode['category'], 'memory'>;
    readonly sourceDate: string;
    readonly text: string;
    readonly sourceNodeIds: readonly string[];
  }>();
  const resolveParent = (parentId: string) => temporaryIds.get(parentId) ?? parentId;

  const pending = changes.filter((change) => change.action === 'create');
  while (createdEntries.size < pending.length) {
    let progressed = false;
    for (const change of pending) {
      const nodeId = temporaryIds.get(change.temporaryId)!;
      if (createdEntries.has(nodeId)) continue;
      const parentId = resolveParent(change.parentId);
      const parent = entries.get(parentId) ?? createdEntryAsCanonical(createdEntries.get(parentId));
      if (!parent) continue;
      const validParent = change.category === 'episode'
        ? parent.category === 'memory'
        : parent.category === 'episode';
      if (!validParent) {
        throw new Error(`Memory consolidation create has an invalid parent: ${change.temporaryId}`);
      }
      for (const sourceNodeId of change.sourceNodeIds) {
        if (!selectedById.has(sourceNodeId)) {
          throw new Error(`Memory consolidation create cites an unselected source Node: ${sourceNodeId}`);
        }
      }
      const lineage = currentLineage(change.sourceNodeIds, control);
      if (lineage.length === 0) {
        throw new Error(`Memory consolidation create has no current evidence: ${change.temporaryId}`);
      }
      createdEntries.set(nodeId, {
        nodeId,
        parentId,
        category: change.category,
        sourceDate: parent.sourceDate,
        text: change.text,
        sourceNodeIds: change.sourceNodeIds,
      });
      progressed = true;
    }
    if (!progressed) throw new Error('Memory consolidation create graph has an unresolved parent');
  }

  const committedRollbacks = control.activeRollbacks().filter((rollback) => rollback.status === 'committed');
  const unsupportedNodeIds = new Set(control.generatedNodeIdsWithoutCurrentSupport().filter((nodeId) => entries.has(nodeId)));
  const releasedNodeIds = new Set<string>();
  const transferredLineage = new Map<string, readonly MemoryLineageInput[]>();
  if (unsupportedNodeIds.size > 0) {
    for (const node of selected) {
      if (!unsupportedNodeIds.has(node.nodeId)) continue;
      const proposed = existingChanges.get(node.nodeId);
      if (proposed?.action === 'update') {
        if (currentLineage(proposed.sourceNodeIds, control).length === 0) {
          throw new Error(`Memory consolidation update has no current evidence: ${node.nodeId}`);
        }
        continue;
      }
      const descendants = projectionDescendants(node.nodeId, timeline);
      const hasAuthoritativeDescendant = descendants.some((nodeId) => {
        const record = generated.get(nodeId);
        return !record || record.userAuthoritative;
      });
      if (hasAuthoritativeDescendant) {
        releasedNodeIds.add(node.nodeId);
        existingChanges.set(node.nodeId, { nodeId: node.nodeId, action: 'keep' });
        continue;
      }
      const supportingDescendants = descendants.filter((nodeId) => !unsupportedNodeIds.has(nodeId));
      const inherited = currentLineage(supportingDescendants, control);
      if (inherited.length > 0) {
        transferredLineage.set(node.nodeId, inherited);
        existingChanges.set(node.nodeId, { nodeId: node.nodeId, action: 'keep' });
        continue;
      }
      const completeSelectedSubtree = descendants.every((nodeId) => (
        unsupportedNodeIds.has(nodeId) && selectedById.has(nodeId)
      ));
      existingChanges.set(node.nodeId, {
        nodeId: node.nodeId,
        action: completeSelectedSubtree ? 'delete' : 'keep',
      });
    }
  }

  const deletedNodeIds = new Set([...existingChanges.values()].flatMap((change) => (
    change.action === 'delete' ? [change.nodeId] : []
  )));
  for (const nodeId of deletedNodeIds) {
    const entry = entries.get(nodeId);
    const record = generated.get(nodeId);
    if (!entry || !selectedById.has(nodeId)) {
      throw new Error(`Memory consolidation targeted an unselected Node: ${nodeId}`);
    }
    if (!record || record.userAuthoritative) {
      throw new Error(`Memory consolidation cannot delete user-authoritative Node: ${nodeId}`);
    }
    for (const descendantId of projectionDescendants(entry.node.id, timeline)) {
      const descendant = generated.get(descendantId);
      if (!deletedNodeIds.has(descendantId) || !descendant || descendant.userAuthoritative) {
        throw new Error(`Memory consolidation cannot delete a Node with retained descendants: ${nodeId}`);
      }
    }
  }
  const canonicalChanges: TimelineConsolidationChange[] = [];
  const upsertedNodes: MemoryGeneratedNodeRecord[] = [];
  const lineage: MemoryLineageInput[] = [];
  for (const node of selected) {
    const change = existingChanges.get(node.nodeId) ?? { nodeId: node.nodeId, action: 'keep' as const };
    canonicalChanges.push(change.action === 'update'
      ? { nodeId: change.nodeId, action: 'update', text: change.text }
      : change);
    if (change.action !== 'update') continue;
    const entry = entries.get(node.nodeId);
    const record = generated.get(node.nodeId);
    if (!entry || !record || record.userAuthoritative) {
      throw new Error(`Memory consolidation cannot update user-authoritative Node: ${node.nodeId}`);
    }
    upsertedNodes.push({
      ...record,
      fingerprint: timelineNodeFingerprint(entry, change.text),
    });
    const evidence = currentLineage(change.sourceNodeIds, control);
    if (evidence.length === 0) throw new Error(`Memory consolidation update has no current evidence: ${node.nodeId}`);
    for (const edge of evidence) lineage.push({ ...edge, nodeId: node.nodeId });
  }
  for (const [nodeId, evidence] of transferredLineage) {
    if (upsertedNodes.some((node) => node.nodeId === nodeId)) continue;
    const record = generated.get(nodeId);
    if (!record || record.userAuthoritative) continue;
    upsertedNodes.push(record);
    for (const edge of evidence) lineage.push({ ...edge, nodeId });
  }

  for (const change of pending) {
    const created = createdEntries.get(temporaryIds.get(change.temporaryId)!)!;
    canonicalChanges.push({
      nodeId: created.nodeId,
      action: 'create',
      parentId: created.parentId,
      category: created.category,
      text: created.text,
    });
    upsertedNodes.push({
      nodeId: created.nodeId,
      category: created.category,
      sourceDate: created.sourceDate,
      fingerprint: memoryNodeFingerprint({
        category: created.category,
        sourceDate: created.sourceDate,
        parentKey: created.parentId,
        tags: [memoryTagId(created.category)],
        text: created.text,
      }),
      userAuthoritative: false,
      generatedAt: Date.now(),
    });
    for (const edge of currentLineage(created.sourceNodeIds, control)) {
      lineage.push({ ...edge, nodeId: created.nodeId });
    }
  }
  for (const created of createdEntries.values()) {
    if (deletedNodeIds.has(created.parentId)) {
      throw new Error(`Memory consolidation cannot create beneath a deleted Node: ${created.nodeId}`);
    }
  }
  const resolvedUnsupportedNodeIds = new Set([
    ...deletedNodeIds,
    ...releasedNodeIds,
    ...upsertedNodes.map((node) => node.nodeId),
  ]);
  const remainingUnsupported = [...unsupportedNodeIds]
    .filter((nodeId) => !resolvedUnsupportedNodeIds.has(nodeId));
  const reconciledRollbackIds = remainingUnsupported.length === 0
    ? committedRollbacks.map((rollback) => rollback.rollbackId)
    : [];
  return {
    changes: Object.freeze(canonicalChanges),
    upsertedNodes: Object.freeze(upsertedNodes),
    lineage: Object.freeze(lineage),
    releasedNodeIds: Object.freeze([...releasedNodeIds]),
    reconciledRollbackIds: Object.freeze(reconciledRollbackIds),
    needsFollowUp: remainingUnsupported.length > 0,
  };
}

function createdEntryAsCanonical(entry: {
  readonly nodeId: string;
  readonly parentId: string;
  readonly category: Exclude<MemoryConsolidationNode['category'], 'memory'>;
  readonly sourceDate: string;
  readonly text: string;
} | undefined): Pick<CanonicalMemoryNode, 'category' | 'sourceDate'> | null {
  return entry ? { category: entry.category, sourceDate: entry.sourceDate } : null;
}

function currentLineage(nodeIds: readonly string[], control: MemoryControlStore): readonly MemoryLineageInput[] {
  const byOrigin = new Map<string, MemoryLineageInput>();
  for (const nodeId of nodeIds) {
    for (const edge of control.lineageForNode(nodeId)) {
      if (control.isOriginClaimed(edge.originItemId)) byOrigin.set(edge.originItemId, edge);
    }
  }
  return [...byOrigin.values()];
}

function projectionDescendants(nodeId: string, timeline: TimelineMemoryStore): readonly string[] {
  const projection = timeline.projection();
  const index = new Map(projection.nodes.map((node) => [node.id, node]));
  const descendants: string[] = [];
  const stack = [...(index.get(nodeId)?.children ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    descendants.push(current);
    stack.push(...(index.get(current)?.children ?? []));
  }
  return descendants;
}

function nodeDepth(nodeId: string, projection: DocumentProjection): number {
  const index = new Map(projection.nodes.map((node) => [node.id, node]));
  let current = index.get(nodeId);
  let depth = 0;
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    current = index.get(current.parentId);
    depth += 1;
  }
  return depth;
}

function consolidationPrompt(nodes: readonly MemoryConsolidationNode[]): string {
  return JSON.stringify({
    task: 'Reconcile the selected Daily Timeline Memory graph.',
    rules: [
      'Keep user-authored or user-edited Nodes unchanged.',
      'Update concise generated beliefs, questions, guidance, episodes, and headlines only when evidence supports it.',
      'Delete unsupported generated Nodes only when every descendant is also supplied as a generated delete.',
      'Merge duplicate generated episodes by updating the retained episode and deleting the complete duplicate subtree.',
      'Create an episode or category Node only beneath a supplied or newly created canonical parent.',
      'For every create or update, cite supplied sourceNodeIds that carry current evidence.',
      'Use temporary IDs in the form new:<name> for created Nodes. Return one change per supplied or temporary ID.',
    ],
    nodes,
    output: {
      changes: [
        {
          nodeId: 'exact supplied id',
          action: 'update',
          text: 'updated Memory text',
          sourceNodeIds: ['supplied nodeId carrying evidence'],
        },
        { nodeId: 'exact supplied id', action: 'keep | delete' },
        {
          temporaryId: 'new:short-name',
          action: 'create',
          parentId: 'supplied nodeId or earlier temporaryId',
          category: 'episode | belief | question | guidance',
          text: 'new Memory text',
          sourceNodeIds: ['supplied nodeId carrying evidence'],
        },
      ],
    },
  });
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Memory consolidation did not return a JSON object');
  return JSON.parse(fenced.slice(start, end + 1));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function abortError(): Error {
  const error = new Error('Memory consolidation was interrupted');
  error.name = 'AbortError';
  return error;
}

const CONSOLIDATION_SYSTEM_PROMPT = `You consolidate canonical Memory Nodes on a daily timeline.
Return exact JSON and nothing else. Treat user-authored or user-edited Nodes as authoritative.
Never invent evidence. Preserve useful uncertainty. Keep guidance actionable and concise.
Use only supplied Node IDs and obey every mutation restriction in the input.`;

export type { ConsolidationPublicationPayload };
