import type { DocumentProjection, NodeProjection } from '../../../../core/types';
import { isoLocalDate } from '../../../../core/localDate';
import type { MemoryConsolidationNode, MemoryOriginSource, MemorySubject } from '../../../../core/agent/memory';
import type { MemoryControlStore, MemoryGeneratedNodeRecord, MemoryLineageInput, MemoryRollbackRecord } from './MemoryControlStore';
import { TimelineMemoryStore, timelineDigest, timelineNodeFingerprint, timelineSubtreeFingerprint, type CanonicalMemoryGraph } from './TimelineMemoryStore';
import { sourcesSupportSubject } from './MemorySupport';

export const MAX_CONSOLIDATION_NODES = 240;
const UNUSED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type MemorySourceReadiness =
  | { readonly kind: 'known'; readonly pendingDates: ReadonlySet<string> }
  | { readonly kind: 'unavailable' };

export interface ConsolidationSnapshot {
  readonly projection: DocumentProjection;
  readonly graph: CanonicalMemoryGraph;
  readonly nodes: ReadonlyMap<string, NodeProjection>;
  readonly entries: ReadonlyMap<string, CanonicalMemoryGraph['nodes'][number]>;
  readonly generated: ReadonlyMap<string, MemoryGeneratedNodeRecord>;
  readonly lineage: ReadonlyMap<string, readonly MemoryLineageInput[]>;
  readonly origins: ReadonlyMap<string, MemoryOriginSource>;
  readonly usage: ReadonlyMap<string, { readonly count: number; readonly lastUsage: number | null }>;
  readonly rollbacks: readonly MemoryRollbackRecord[];
  readonly status: ReturnType<MemoryControlStore['status']>;
  readonly now: number;
  readonly today: string;
}

/** The owner reconciles observed edits, then detaches the data used by planning. */
export function captureConsolidationSnapshot(
  timeline: TimelineMemoryStore, control: MemoryControlStore, now: number, withUsage = false,
): ConsolidationSnapshot {
  const live = timeline.projection();
  const projection = { ...live, nodes: live.nodes.map((node) => ({
    ...node, content: { ...node.content }, children: [...node.children], tags: [...node.tags],
  })) } as DocumentProjection;
  const graph = timeline.graph(projection);
  const records = control.generatedNodesById();
  for (const entry of graph.nodes) {
    const record = records.get(entry.node.id);
    if (record && !record.userAuthoritative && record.fingerprint !== timelineNodeFingerprint(entry)) {
      control.markNodeUserAuthoritative(entry.node.id);
    }
  }
  const generated = new Map([...control.generatedNodesById()].map(([id, value]) => [id, { ...value }]));
  const lineage = new Map<string, readonly MemoryLineageInput[]>();
  const origins = new Map<string, MemoryOriginSource>();
  const usage = new Map<string, { count: number; lastUsage: number | null }>();
  for (const entry of graph.nodes) {
    const edges = control.lineageForNode(entry.node.id);
    lineage.set(entry.node.id, edges.map((edge) => ({ ...edge })));
    for (const edge of edges) {
      if (origins.has(edge.originItemId)) continue;
      const origin = control.originSource(edge.originItemId);
      if (origin) origins.set(origin.originItemId, origin);
    }
    if (withUsage) usage.set(entry.node.id, control.usageForNode(entry.node.id));
  }
  return {
    projection, graph, nodes: new Map(projection.nodes.map((node) => [node.id, node])),
    entries: new Map(graph.nodes.map((entry) => [entry.node.id, entry])), generated, lineage, origins, usage,
    rollbacks: control.activeRollbacks().map((record) => ({ ...record, omittedTurnIds: [...record.omittedTurnIds] })),
    status: control.status(), now, today: isoLocalDate(new Date(now)),
  };
}

export function sourceIdsSupportSubject(snapshot: ConsolidationSnapshot, subject: MemorySubject, ids: readonly string[]): boolean {
  return sourcesSupportSubject(subject, ids.map((id) => snapshot.origins.get(id)));
}

export function requireSnapshotSupport(snapshot: ConsolidationSnapshot, subject: MemorySubject, edges: readonly MemoryLineageInput[]): void {
  if (!sourceIdsSupportSubject(snapshot, subject, edges.map((edge) => edge.originItemId))) {
    throw new Error(subject === 'user' ? 'Personal Memory requires current reader-authored text' : 'Memory has no current evidence');
  }
}

export function currentSnapshotLineage(snapshot: ConsolidationSnapshot, nodeIds: readonly string[]): readonly MemoryLineageInput[] {
  const origins = new Map<string, MemoryLineageInput>();
  for (const nodeId of nodeIds) {
    const edges = (snapshot.lineage.get(nodeId) ?? []).filter((edge) => snapshot.origins.has(edge.originItemId));
    const record = snapshot.generated.get(nodeId);
    if (record && !record.userAuthoritative && !sourceIdsSupportSubject(snapshot, record.subject, edges.map((edge) => edge.originItemId))) continue;
    for (const edge of edges) origins.set(edge.originItemId, edge);
  }
  return [...origins.values()];
}

export function unsupportedSnapshotNodes(snapshot: ConsolidationSnapshot): ReadonlySet<string> {
  return new Set(snapshot.graph.nodes.filter((entry) => {
    const record = snapshot.generated.get(entry.node.id);
    const origins = (snapshot.lineage.get(entry.node.id) ?? []).filter((edge) => snapshot.origins.has(edge.originItemId));
    return record && !record.userAuthoritative && !sourceIdsSupportSubject(snapshot, record.subject, origins.map((edge) => edge.originItemId));
  }).map((entry) => entry.node.id));
}

export function snapshotDescendants(snapshot: ConsolidationSnapshot, id: string): readonly string[] {
  const pending = [...(snapshot.nodes.get(id)?.children ?? [])];
  const visited = new Set<string>([id]);
  const result: string[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    result.push(next);
    pending.push(...(snapshot.nodes.get(next)?.children ?? []));
  }
  return result;
}

export function snapshotDepth(snapshot: ConsolidationSnapshot, id: string): number {
  const seen = new Set<string>();
  let node = snapshot.nodes.get(id);
  let depth = 0;
  while (node?.parentId && !seen.has(node.id)) {
    seen.add(node.id);
    node = snapshot.nodes.get(node.parentId);
    depth++;
  }
  return depth;
}

export function snapshotNodeFingerprint(snapshot: ConsolidationSnapshot, id: string): string {
  const node = snapshot.nodes.get(id);
  const entry = snapshot.entries.get(id);
  const record = snapshot.generated.get(id);
  return timelineDigest({
    node: node ? { id, parentId: node.parentId, children: node.children, text: node.content.text, tags: [...node.tags].sort(),
      category: entry?.category, sourceDate: entry?.sourceDate } : null,
    generated: record ?? null,
    lineage: (snapshot.lineage.get(id) ?? []).map((edge) => ({ ...edge, origin: snapshot.origins.get(edge.originItemId) ?? null })),
  });
}

export function dayNeedsTitle(snapshot: ConsolidationSnapshot, sourceDate: string): boolean {
  return snapshot.graph.containers.some((entry) => entry.sourceDate === sourceDate && entry.node.content.text === 'Memory'
    && snapshot.generated.has(entry.node.id) && !snapshot.generated.get(entry.node.id)!.userAuthoritative
    && snapshot.graph.nodes.some((node) => node.containerId === entry.node.id && node.category !== 'memory'));
}

export function dayReadyForTitle(snapshot: ConsolidationSnapshot, readiness: MemorySourceReadiness, sourceDate: string): boolean {
  return sourceDate < snapshot.today && snapshot.rollbacks.length === 0 && readiness.kind === 'known'
    && !readiness.pendingDates.has(sourceDate)
    && snapshot.graph.nodes.filter((node) => node.sourceDate === sourceDate).length <= MAX_CONSOLIDATION_NODES;
}

export function selectConsolidationNodes(snapshot: ConsolidationSnapshot, readiness: MemorySourceReadiness, sourceDate?: string): readonly MemoryConsolidationNode[] {
  const unsupported = unsupportedSnapshotNodes(snapshot);
  const cleanup = new Set([...unsupported].flatMap((id) => [id, ...snapshotDescendants(snapshot, id)]));
  const ranked = snapshot.graph.nodes.filter((entry) => !sourceDate || entry.sourceDate === sourceDate).map((entry) => {
    const record = snapshot.generated.get(entry.node.id);
    const supportingSources = (snapshot.lineage.get(entry.node.id) ?? []).map((edge) => snapshot.origins.get(edge.originItemId))
      .filter((source): source is MemoryOriginSource => source !== undefined);
    const usage = snapshot.usage.get(entry.node.id) ?? { count: 0, lastUsage: null };
    return { entry, record, supportingSources, usage, depth: snapshotDepth(snapshot, entry.node.id) };
  }).filter(({ entry, record, supportingSources, usage }) => sourceDate || cleanup.has(entry.node.id) || !record || record.userAuthoritative
    || supportingSources.length === 0 || usage.lastUsage !== null || snapshot.now - record.generatedAt <= UNUSED_RETENTION_MS)
    .sort((a, b) => Number(unsupported.has(b.entry.node.id)) - Number(unsupported.has(a.entry.node.id))
      || Number(cleanup.has(b.entry.node.id)) - Number(cleanup.has(a.entry.node.id))
      || b.depth - a.depth || b.usage.count - a.usage.count
      || (b.usage.lastUsage ?? b.record?.generatedAt ?? b.entry.node.updatedAt) - (a.usage.lastUsage ?? a.record?.generatedAt ?? a.entry.node.updatedAt)
      || a.entry.node.id.localeCompare(b.entry.node.id));
  const byId = new Map(ranked.map((node) => [node.entry.node.id, node]));
  const selected = new Set<string>();
  const add = (id: string) => {
    if (byId.has(id) && selected.size < MAX_CONSOLIDATION_NODES) selected.add(id);
  };
  // Reserve space for an unsupported ancestor together with the descendants
  // that can resolve it. Many unsupported parents must not crowd out all work.
  for (const node of ranked) {
    if (selected.size === MAX_CONSOLIDATION_NODES) break;
    if (!unsupported.has(node.entry.node.id)) continue;
    add(node.entry.node.id);
    const children = [...snapshotDescendants(snapshot, node.entry.node.id)]
      .sort((a, b) => (byId.get(b)?.depth ?? 0) - (byId.get(a)?.depth ?? 0));
    for (const child of children) add(child);
  }
  for (const node of ranked) add(node.entry.node.id);
  return [...selected].map((id) => byId.get(id)!).map(({ entry, record, supportingSources }): MemoryConsolidationNode => {
    const dayRecords = entry.category === 'memory'
      ? snapshot.graph.nodes.filter((node) => node.containerId === entry.node.id && node.category !== 'memory') : [];
    const title = entry.category === 'memory' && record && !record.userAuthoritative && dayRecords.length > 0
      && dayRecords.every((node) => selected.has(node.node.id)) && dayReadyForTitle(snapshot, readiness, entry.sourceDate);
    return {
      nodeId: entry.node.id, parentId: entry.node.parentId ?? null, category: entry.category, sourceDate: entry.sourceDate,
      text: entry.node.content.text, generated: Boolean(record && !record.userAuthoritative), fingerprint: timelineNodeFingerprint(entry),
      subject: record?.subject ?? null, supportingSources, supportingOriginItemIds: supportingSources.map((source) => source.originItemId),
      ...(title ? { titleSourceNodeIds: dayRecords.map((node) => node.node.id), titleSubtreeFingerprint: timelineSubtreeFingerprint(entry.node.id, snapshot.projection)! } : {}),
    };
  });
}
