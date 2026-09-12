import { memoryTagId, type MemoryConsolidationChange, type MemoryConsolidationNode, type MemoryConsolidationOutput } from '../../../../core/agent/memory';
import type { MemoryGeneratedNodeRecord, MemoryLineageInput } from './MemoryControlStore';
import { memoryNodeFingerprint, timelineNodeFingerprint, type TimelineConsolidationChange } from './TimelineMemoryStore';
import {
  type ConsolidationSnapshot, currentSnapshotLineage, requireSnapshotSupport, snapshotDepth,
  snapshotDescendants, snapshotNodeFingerprint, sourceIdsSupportSubject, unsupportedSnapshotNodes,
} from './ConsolidationSnapshot';

export const CONSOLIDATION_RETRY_MS = 60_000;

export interface ConsolidationPlan {
  readonly changes: readonly TimelineConsolidationChange[];
  readonly upsertedNodes: readonly MemoryGeneratedNodeRecord[];
  readonly lineage: readonly MemoryLineageInput[];
  readonly releasedNodeIds: readonly string[];
  readonly reconciledRollbackIds: readonly string[];
  readonly inputFingerprints: Readonly<Record<string, string>>;
  readonly followUpAt: number | null;
  readonly hasPublication: boolean;
}

type ExistingChange = Exclude<MemoryConsolidationChange, { action: 'create' }>;
type Creation = Extract<TimelineConsolidationChange, { action: 'create' }>;

/** Local overlay only: planning never reads or writes a live owner. */
class Draft {
  readonly changes = new Map<string, ExistingChange>();
  readonly creates = new Map<string, Creation>();
  readonly moves = new Map<string, string>();
  readonly records = new Map<string, MemoryGeneratedNodeRecord>();
  readonly evidence = new Map<string, readonly MemoryLineageInput[]>();
  readonly released = new Set<string>();
  readonly dependencies = new Set<string>();

  constructor(readonly snapshot: ConsolidationSnapshot, readonly selected: ReadonlyMap<string, MemoryConsolidationNode>) {
    for (const id of selected.keys()) this.dependencies.add(id);
  }

  descendants(id: string): readonly string[] {
    const descendants = snapshotDescendants(this.snapshot, id);
    this.dependencies.add(id);
    for (const child of descendants) this.dependencies.add(child);
    return descendants;
  }

  lineage(ids: readonly string[]): readonly MemoryLineageInput[] {
    for (const id of ids) this.dependencies.add(id);
    return currentSnapshotLineage(this.snapshot, ids);
  }

  deleted(id: string): boolean { return this.changes.get(id)?.action === 'delete'; }

  children(id: string): readonly string[] {
    return [
      ...(this.snapshot.nodes.get(id)?.children ?? []).filter((child) => !this.deleted(child) && !this.moves.has(child)),
      ...[...this.moves].filter(([, parent]) => parent === id).map(([child]) => child),
      ...[...this.creates.values()].filter((child) => child.parentId === id).map((child) => child.nodeId),
    ];
  }

  retain(id: string, evidence: readonly MemoryLineageInput[]): void {
    this.records.set(id, this.snapshot.generated.get(id)!);
    this.evidence.set(id, evidence);
    this.changes.set(id, { action: 'keep', nodeId: id });
  }
}

export function planConsolidation(
  snapshot: ConsolidationSnapshot,
  selected: readonly MemoryConsolidationNode[],
  proposals: readonly MemoryConsolidationChange[],
  temporaryIds: ReadonlyMap<string, string>,
): ConsolidationPlan {
  const draft = new Draft(snapshot, new Map(selected.map((node) => [node.nodeId, node])));
  applyProposals(draft, proposals, temporaryIds);
  const unsupported = unsupportedSnapshotNodes(snapshot);
  reconcileUnsupported(draft, unsupported);
  validateFinalStructure(draft);
  return materializePlan(draft, unsupported);
}

function applyProposals(draft: Draft, proposals: readonly MemoryConsolidationChange[], temporaryIds: ReadonlyMap<string, string>): void {
  const { snapshot, selected } = draft;
  for (const change of validateConsolidationChanges({ changes: proposals }, [...selected.values()])) {
    if (change.action === 'create') continue;
    draft.changes.set(change.nodeId, change);
    if (change.action !== 'update') continue;
    const entry = snapshot.entries.get(change.nodeId)!;
    const record = snapshot.generated.get(change.nodeId);
    if (!record || record.userAuthoritative) throw new Error(`Memory consolidation cannot update user-authoritative Node: ${change.nodeId}`);
    const node = selected.get(change.nodeId)!;
    const evidence = draft.lineage(node.category === 'memory' ? node.titleSourceNodeIds! : change.sourceNodeIds);
    requireSnapshotSupport(snapshot, change.subject, evidence);
    draft.records.set(change.nodeId, { ...record, subject: change.subject, fingerprint: timelineNodeFingerprint(entry, change.text) });
    draft.evidence.set(change.nodeId, evidence);
  }

  const pending = proposals.filter((change) => change.action === 'create');
  while (draft.creates.size < pending.length) {
    let progressed = false;
    for (const change of pending) {
      const nodeId = temporaryIds.get(change.temporaryId);
      if (!nodeId) throw new Error(`Memory create has no allocated ID: ${change.temporaryId}`);
      if (draft.creates.has(nodeId)) continue;
      const parentId = temporaryIds.get(change.parentId) ?? change.parentId;
      const parent = snapshot.entries.get(parentId) ?? draft.records.get(parentId);
      if (!parent) continue;
      if (change.category === 'episode' ? parent.category !== 'memory' : !['memory', 'episode'].includes(parent.category)) {
        throw new Error(`Memory consolidation create has an invalid parent: ${change.temporaryId}`);
      }
      if (change.sourceNodeIds.some((id) => !selected.has(id))) throw new Error('Memory consolidation create cites an unselected source Node');
      if (snapshot.nodes.has(parentId)) draft.dependencies.add(parentId);
      const evidence = draft.lineage(change.sourceNodeIds);
      requireSnapshotSupport(snapshot, change.subject, evidence);
      draft.creates.set(nodeId, { action: 'create', nodeId, parentId, category: change.category, text: change.text });
      draft.records.set(nodeId, {
        nodeId, subject: change.subject, category: change.category, sourceDate: parent.sourceDate,
        fingerprint: memoryNodeFingerprint({ category: change.category, sourceDate: parent.sourceDate,
          parentKey: parentId, tags: [memoryTagId(change.category)], text: change.text }),
        userAuthoritative: false, generatedAt: snapshot.now,
      });
      draft.evidence.set(nodeId, evidence);
      progressed = true;
    }
    if (!progressed) throw new Error('Memory consolidation create graph has an unresolved parent');
  }
}

function reconcileUnsupported(draft: Draft, unsupported: ReadonlySet<string>): void {
  const { snapshot } = draft;
  const candidates = [...draft.selected.keys()].filter((id) => unsupported.has(id))
    .sort((a, b) => snapshotDepth(snapshot, b) - snapshotDepth(snapshot, a));
  for (const id of candidates) {
    if (draft.changes.get(id)?.action === 'update') continue;
    const descendants = draft.descendants(id);
    if (descendants.some((child) => !snapshot.generated.has(child) || snapshot.generated.get(child)!.userAuthoritative || draft.released.has(child))) {
      draft.released.add(id);
      draft.changes.set(id, { nodeId: id, action: 'keep' });
      continue;
    }
    const retained = descendants.filter((child) => !draft.deleted(child));
    const evidence = new Map<string, MemoryLineageInput>();
    for (const child of retained) {
      for (const edge of draft.evidence.get(child) ?? draft.lineage([child])) evidence.set(edge.originItemId, edge);
    }
    const inherited = [...evidence.values()];
    const record = snapshot.generated.get(id)!;
    if (sourceIdsSupportSubject(snapshot, record.subject, inherited.map((edge) => edge.originItemId))) {
      draft.retain(id, inherited);
      continue;
    }
    const entry = snapshot.entries.get(id)!;
    if (entry.category === 'episode') {
      // Each selected surviving leaf can leave independently. A large episode
      // therefore shrinks on every batch even when the model only says keep.
      for (const child of [...descendants].sort((a, b) => snapshotDepth(snapshot, b) - snapshotDepth(snapshot, a))) {
        if (!draft.selected.has(child) || draft.deleted(child) || draft.moves.has(child) || draft.children(child).length > 0) continue;
        const childRecord = draft.records.get(child) ?? snapshot.generated.get(child);
        if (!childRecord || childRecord.userAuthoritative) continue;
        const support = draft.evidence.get(child) ?? draft.lineage([child]);
        if (!sourceIdsSupportSubject(snapshot, childRecord.subject, support.map((edge) => edge.originItemId))) continue;
        draft.moves.set(child, entry.containerId);
        draft.dependencies.add(entry.containerId);
        draft.records.set(child, childRecord);
        draft.evidence.set(child, support);
      }
    }
    draft.changes.set(id, { nodeId: id, action: draft.children(id).length === 0 ? 'delete' : 'keep' });
  }
}

function validateFinalStructure(draft: Draft): void {
  for (const change of draft.changes.values()) {
    if (change.action !== 'delete') continue;
    const record = draft.snapshot.generated.get(change.nodeId);
    if (!record || record.userAuthoritative) throw new Error(`Memory consolidation cannot delete user-authoritative Node: ${change.nodeId}`);
    draft.descendants(change.nodeId);
    if (draft.children(change.nodeId).length > 0) {
      throw new Error(`Memory consolidation cannot delete a Node with retained descendants: ${change.nodeId}`);
    }
  }
  for (const created of draft.creates.values()) {
    if (draft.deleted(created.parentId)) throw new Error(`Memory consolidation cannot create beneath a deleted Node: ${created.nodeId}`);
  }
  for (const [id, parent] of draft.moves) {
    if (draft.deleted(parent)) throw new Error(`Memory consolidation cannot move beneath a deleted Node: ${id}`);
  }
}

function materializePlan(draft: Draft, unsupported: ReadonlySet<string>): ConsolidationPlan {
  const { snapshot } = draft;
  const changes: TimelineConsolidationChange[] = [...draft.changes.values()].filter((change) => change.action !== 'keep')
    .map((change) => change.action === 'update' ? { nodeId: change.nodeId, action: 'update', text: change.text } : change);
  changes.push(...draft.creates.values());
  for (const [nodeId, parentId] of draft.moves) {
    const entry = snapshot.entries.get(nodeId)!;
    const update = draft.changes.get(nodeId);
    const record = draft.records.get(nodeId)!;
    draft.records.set(nodeId, { ...record, fingerprint: memoryNodeFingerprint({
      category: entry.category, sourceDate: entry.sourceDate, parentKey: parentId, tags: entry.node.tags,
      text: update?.action === 'update' ? update.text : entry.node.content.text,
    }) });
    changes.push({ action: 'move', nodeId, parentId });
  }
  const remaining = [...unsupported].filter((id) => !draft.deleted(id) && !draft.released.has(id) && !draft.records.has(id));
  const cleanupProgress = remaining.length < unsupported.size || draft.moves.size > 0;
  const reconciledRollbackIds = remaining.length === 0
    ? snapshot.rollbacks.filter((rollback) => rollback.status === 'committed').map((rollback) => rollback.rollbackId) : [];
  return {
    changes, upsertedNodes: [...draft.records.values()],
    lineage: [...draft.evidence].flatMap(([nodeId, edges]) => edges.map((edge) => ({ ...edge, nodeId }))),
    releasedNodeIds: [...draft.released], reconciledRollbackIds,
    inputFingerprints: Object.fromEntries([...draft.dependencies].map((id) => [id, snapshotNodeFingerprint(snapshot, id)])),
    followUpAt: remaining.length > 0 ? snapshot.now + (cleanupProgress ? 0 : CONSOLIDATION_RETRY_MS) : null,
    hasPublication: changes.length > 0 || draft.records.size > 0 || draft.released.size > 0 || reconciledRollbackIds.length > 0,
  };
}

/** Evaluate naming completion from the final plan without rereading live state. */
export function planLeavesDayUnnamed(snapshot: ConsolidationSnapshot, plan: ConsolidationPlan, sourceDate: string): boolean {
  const updates = new Map(plan.changes.filter((change) => change.action === 'update').map((change) => [change.nodeId, change.text]));
  const deleted = new Set(plan.changes.filter((change) => change.action === 'delete').map((change) => change.nodeId));
  return snapshot.graph.containers.some((entry) => {
    const id = entry.node.id;
    const record = snapshot.generated.get(id);
    return entry.sourceDate === sourceDate && record && !record.userAuthoritative && !plan.releasedNodeIds.includes(id)
      && !deleted.has(id) && (updates.get(id) ?? entry.node.content.text) === 'Memory'
      && (snapshot.graph.nodes.some((node) => node.containerId === id && node.category !== 'memory' && !deleted.has(node.node.id))
        || plan.changes.some((change) => change.action === 'create' && (change.parentId === id || snapshot.entries.get(change.parentId)?.containerId === id)));
  });
}

export function validateConsolidationChanges(
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
    if (change.action === 'update' && node.subject === 'user' && change.subject !== 'user') {
      throw new Error('Personal Memory cannot be reclassified as context');
    }
    if (node.category === 'memory' && change.action === 'update') {
      if (change.subject !== 'context') throw new Error('A Memory day title is context, not a personal claim');
      if (!node.titleSourceNodeIds?.length) throw new Error('Memory title requires the complete source-day record set');
      if (change.text.length > 160) throw new Error('Memory title exceeds 160 characters');
      if (change.sourceNodeIds.some((id) => !node.titleSourceNodeIds!.includes(id))) {
        throw new Error('Memory title can cite only records inside its own source day');
      }
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
