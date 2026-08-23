import { createHash } from 'node:crypto';
import {
  MEMORY_TAG_DEFINITIONS,
  memoryCategoryForTagId,
  memoryTagId,
  type MemoryCategory,
} from '../../../../core/agent/memory';
import {
  DAILY_NOTES_ID,
  TAG_DAY_ID,
  TRASH_ID,
  plainText,
  type DocumentProjection,
  type NodeProjection,
} from '../../../../core/types';
import type {
  Change,
  Operation,
  TargetRef,
  UpdateInstruction,
} from '../../../../outline/contract';
import type { OutlineMutationOptions } from '../../../outlineDocumentService';
import { nodeIsInSubtree } from '../../../../core/treeUtils';
import { Mutex } from '../../Mutex';

export interface TimelineMemoryHost {
  getProjection(): DocumentProjection;
  runChanges(changes: readonly Change[], options?: OutlineMutationOptions): Promise<unknown>;
  log(input: { readonly idempotencyKey?: string; readonly limit?: number }): Promise<readonly Operation[]>;
}

export interface PreparedTimelineDateOutput {
  readonly sourceDate: string;
  readonly headline: string;
  readonly episode: string;
  readonly beliefs: readonly string[];
  readonly questions: readonly string[];
  readonly guidance: readonly string[];
  readonly containerId: string;
  readonly containerGenerated: boolean;
  readonly episodeId: string;
  readonly beliefIds: readonly string[];
  readonly questionIds: readonly string[];
  readonly guidanceIds: readonly string[];
}

export interface TimelinePublication {
  readonly operationId: string;
  readonly generation: number;
  readonly digest: string;
  readonly dates: readonly PreparedTimelineDateOutput[];
}

export interface CanonicalMemoryNode {
  readonly node: NodeProjection;
  readonly category: MemoryCategory;
  readonly sourceDate: string;
  readonly containerId: string;
  readonly episodeId: string | null;
}

export interface CanonicalMemoryGraph {
  readonly containers: readonly CanonicalMemoryNode[];
  readonly nodes: readonly CanonicalMemoryNode[];
  readonly strayTaggedNodeIds: readonly string[];
}

export interface MemoryVisibilityView {
  readonly generation: number;
  readonly suppressAllGenerated: boolean;
  readonly suppressedGeneratedNodeIds: ReadonlySet<string>;
}

export type TimelineConsolidationChange =
  | { readonly nodeId: string; readonly action: 'keep' }
  | { readonly nodeId: string; readonly action: 'update'; readonly text: string }
  | { readonly nodeId: string; readonly action: 'delete' }
  | {
      readonly nodeId: string;
      readonly action: 'create';
      readonly parentId: string;
      readonly category: Exclude<MemoryCategory, 'memory'>;
      readonly text: string;
    };

export class TimelineMemoryStore {
  private readonly writeGate = new Mutex();

  constructor(private readonly document: TimelineMemoryHost) {}

  withWriteGate<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeGate.run(operation);
  }

  async ensureTagDefinitions(): Promise<void> {
    await this.withWriteGate(async () => {
      const nodes = new Map(this.document.getProjection().nodes.map((node) => [node.id, node]));
      const missing = MEMORY_TAG_DEFINITIONS.filter((definition) => {
        const node = nodes.get(definition.tagId);
        return node?.type !== 'tagDef' || node.content.text.trim() !== definition.name;
      });
      if (missing.length === 0) return;
      await this.document.runChanges(missing.map((definition, index): Change => ({
        op: 'ensure',
        resource: 'definition',
        definitionType: 'tag',
        id: definition.tagId,
        name: definition.name,
        bind: `memoryTag${index + 1}`,
      })), {
        source: { kind: 'automation', label: 'Ensure Memory tag definitions' },
      });
    });
  }

  graph(projection = this.document.getProjection()): CanonicalMemoryGraph {
    return canonicalMemoryGraph(projection);
  }

  projection(): DocumentProjection {
    return this.document.getProjection();
  }

  async publish(publication: TimelinePublication, beforeCommit?: () => void | Promise<void>): Promise<void> {
    await this.withWriteGate(() => this.publishWithinWriteGate(publication, beforeCommit));
  }

  async publishWithinWriteGate(
    publication: TimelinePublication,
    beforeCommit?: () => void | Promise<void>,
  ): Promise<void> {
    await beforeCommit?.();
    const index = nodeIndex(this.document.getProjection());
    const operations: Change[] = [publicationMarker()];
    for (const [dateIndex, date] of publication.dates.entries()) {
      const dateBinding = `memoryDate${dateIndex + 1}`;
      operations.push({
        op: 'ensure', resource: 'date', date: date.sourceDate, bind: dateBinding,
      });
      const container = index.get(date.containerId);
      const containerBinding = `memoryContainer${dateIndex + 1}`;
      const containerRef = container ? oneId(container.id) : binding(containerBinding);
      if (!container) {
        operations.push(createTaggedChange(
          date.containerId,
          binding(dateBinding),
          date.headline,
          memoryTagId('memory'),
          containerBinding,
        ));
      } else if (date.containerGenerated && container.content.text !== date.headline) {
        operations.push(updateTextChange(container.id, date.headline));
      }
      const episodeBinding = `memoryEpisode${dateIndex + 1}`;
      const episodeRef = planUpsertTaggedNode(
        operations,
        index,
        containerRef,
        date.episodeId,
        date.episode,
        'episode',
        episodeBinding,
      );
      for (const [position, text] of date.beliefs.entries()) {
        planUpsertTaggedNode(
          operations, index, episodeRef, date.beliefIds[position]!, text, 'belief',
          `memoryBelief${dateIndex + 1}_${position + 1}`,
        );
      }
      for (const [position, text] of date.questions.entries()) {
        planUpsertTaggedNode(
          operations, index, episodeRef, date.questionIds[position]!, text, 'question',
          `memoryQuestion${dateIndex + 1}_${position + 1}`,
        );
      }
      for (const [position, text] of date.guidance.entries()) {
        planUpsertTaggedNode(
          operations, index, episodeRef, date.guidanceIds[position]!, text, 'guidance',
          `memoryGuidance${dateIndex + 1}_${position + 1}`,
        );
      }
    }
    await this.applyPublication(
      publication.operationId,
      publication.generation,
      publication.digest,
      operations,
    );
  }

  async applyConsolidation(
    operationId: string,
    generation: number,
    digest: string,
    changes: readonly TimelineConsolidationChange[],
    beforeCommit?: () => void | Promise<void>,
  ): Promise<void> {
    await this.withWriteGate(() => this.applyConsolidationWithinWriteGate(
      operationId,
      generation,
      digest,
      changes,
      beforeCommit,
    ));
  }

  async applyConsolidationWithinWriteGate(
    operationId: string,
    generation: number,
    digest: string,
    changes: readonly TimelineConsolidationChange[],
    beforeCommit?: () => void | Promise<void>,
  ): Promise<void> {
    await beforeCommit?.();
    const projection = this.document.getProjection();
    const index = nodeIndex(projection);
    const operations: Change[] = [publicationMarker()];
    const pendingCreates = changes.filter((change) => change.action === 'create');
    const createdBindings = new Map<string, string>();
    while (createdBindings.size < pendingCreates.length) {
      let progressed = false;
      for (const change of pendingCreates) {
        if (createdBindings.has(change.nodeId)) continue;
        const parentBinding = createdBindings.get(change.parentId);
        if (!index.has(change.parentId) && !parentBinding) continue;
        const bind = `memoryCreated${createdBindings.size + 1}`;
        operations.push(createTaggedChange(
          change.nodeId,
          parentBinding ? binding(parentBinding) : oneId(change.parentId),
          change.text,
          memoryTagId(change.category),
          bind,
        ));
        createdBindings.set(change.nodeId, bind);
        progressed = true;
      }
      if (!progressed) throw new Error('Memory consolidation create graph has an unresolved parent');
    }
    for (const change of changes) {
      if (change.action === 'update' && index.has(change.nodeId)) {
        operations.push(updateTextChange(change.nodeId, change.text));
      }
    }
    const deletes = changes
      .filter((change) => change.action === 'delete' && index.has(change.nodeId))
      .sort((left, right) => nodeDepth(right.nodeId, projection) - nodeDepth(left.nodeId, projection));
    operations.push(...deletes.map((change): Change => ({
      op: 'lifecycle', action: 'purge', targets: oneId(change.nodeId),
    })));
    await this.applyPublication(operationId, generation, digest, operations, deletes.length > 0);
  }

  async reset(operationId: string, generation: number, digest: string, containerIds: readonly string[]): Promise<void> {
    await this.withWriteGate(() => this.resetWithinWriteGate(operationId, generation, digest, containerIds));
  }

  async resetWithinWriteGate(
    operationId: string,
    generation: number,
    digest: string,
    containerIds: readonly string[],
  ): Promise<void> {
    const canonicalContainers = new Set(this.graph().containers.map((entry) => entry.node.id));
    const targets = containerIds.filter((nodeId) => canonicalContainers.has(nodeId));
    const operations: Change[] = [
      publicationMarker(),
      ...targets.map((nodeId): Change => ({
        op: 'lifecycle', action: 'purge', targets: oneId(nodeId),
      })),
    ];
    await this.applyPublication(operationId, generation, digest, operations, targets.length > 0);
  }

  async hasPublication(operationId: string, digest: string): Promise<boolean> {
    const operations = await this.document.log({ idempotencyKey: operationId, limit: 1 });
    const operation = operations[0];
    return operation?.source?.fingerprint === digest;
  }

  visibleNodes(view: MemoryVisibilityView, generatedNodeIds: ReadonlySet<string>): readonly CanonicalMemoryNode[] {
    return this.graph().nodes.filter((entry) => {
      if (!generatedNodeIds.has(entry.node.id)) return true;
      return !view.suppressAllGenerated && !view.suppressedGeneratedNodeIds.has(entry.node.id);
    });
  }

  private async applyPublication(
    operationId: string,
    generation: number,
    digest: string,
    changes: readonly Change[],
    acknowledgeDestructive = false,
  ): Promise<void> {
    await this.document.runChanges(changes, {
      idempotencyKey: operationId,
      source: {
        kind: 'automation',
        label: `Memory publication generation ${generation}`,
        fingerprint: digest,
      },
      ...(acknowledgeDestructive ? { acknowledgeDestructive: true } : {}),
    });
  }
}

export function canonicalMemoryGraph(projection: DocumentProjection): CanonicalMemoryGraph {
  const index = nodeIndex(projection);
  const tagged = projection.nodes.filter((node) => node.tags.some((tagId) => memoryCategoryForTagId(tagId) !== null));
  const containers: CanonicalMemoryNode[] = [];
  const nodes: CanonicalMemoryNode[] = [];
  const canonicalIds = new Set<string>();

  for (const node of tagged) {
    const container = canonicalMemoryNodeFromIndex(node, index);
    if (!container || container.category !== 'memory') continue;
    containers.push(container);
    nodes.push(container);
    canonicalIds.add(node.id);

    for (const episodeId of node.children) {
      const episode = index.get(episodeId);
      if (!episode) continue;
      const episodeEntry = canonicalMemoryNodeFromIndex(episode, index);
      if (
        !episodeEntry
        || episodeEntry.category !== 'episode'
        || episodeEntry.containerId !== container.node.id
      ) continue;
      nodes.push(episodeEntry);
      canonicalIds.add(episode.id);
      const stack = [...episode.children];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const childId = stack.shift()!;
        if (visited.has(childId)) continue;
        visited.add(childId);
        const child = index.get(childId);
        if (!child) continue;
        stack.push(...child.children);
        const entry = canonicalMemoryNodeFromIndex(child, index);
        if (
          !entry
          || !isLeafMemoryCategory(entry.category)
          || entry.containerId !== container.node.id
          || entry.episodeId !== episode.id
        ) continue;
        nodes.push(entry);
        canonicalIds.add(child.id);
      }
    }
  }

  return {
    containers: Object.freeze(containers),
    nodes: Object.freeze(nodes),
    strayTaggedNodeIds: Object.freeze(tagged.map((node) => node.id).filter((id) => !canonicalIds.has(id))),
  };
}

export function canonicalMemoryNodeFromIndex(
  node: NodeProjection,
  index: ReadonlyMap<string, NodeProjection>,
): CanonicalMemoryNode | null {
  if (nodeIsInSubtree(index, node.id, TRASH_ID)) return null;
  const directContainer = canonicalMemoryContainer(node, index);
  if (directContainer) return directContainer;

  const path: NodeProjection[] = [node];
  const visited = new Set<string>([node.id]);
  let current = node.parentId ? index.get(node.parentId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    const container = canonicalMemoryContainer(current, index);
    if (container) {
      const episode = path.at(-2);
      if (!episode || !episode.tags.includes(memoryTagId('episode'))) return null;
      if (node.id === episode.id) {
        return {
          node,
          category: 'episode',
          sourceDate: container.sourceDate,
          containerId: container.node.id,
          episodeId: episode.id,
        };
      }
      const category = node.tags.map(memoryCategoryForTagId).find(isLeafMemoryCategory);
      return category ? {
        node,
        category,
        sourceDate: container.sourceDate,
        containerId: container.node.id,
        episodeId: episode.id,
      } : null;
    }
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return null;
}

export function canonicalMemoryContainerAncestorFromIndex(
  node: NodeProjection,
  index: ReadonlyMap<string, NodeProjection>,
): CanonicalMemoryNode | null {
  const visited = new Set<string>();
  let current: NodeProjection | undefined = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const container = canonicalMemoryContainer(current, index);
    if (container) return container;
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return null;
}

function canonicalMemoryContainer(
  node: NodeProjection,
  index: ReadonlyMap<string, NodeProjection>,
): CanonicalMemoryNode | null {
  if (
    !node.tags.includes(memoryTagId('memory'))
    || !node.parentId
    || nodeIsInSubtree(index, node.id, TRASH_ID)
  ) return null;
  const day = index.get(node.parentId);
  if (
    !day
    || !isDayNodeInsideDailyNotes(day, index)
    || !/^\d{4}-\d{2}-\d{2}$/.test(day.content.text)
  ) return null;
  return {
    node,
    category: 'memory',
    sourceDate: day.content.text,
    containerId: node.id,
    episodeId: null,
  };
}

function isLeafMemoryCategory(
  value: MemoryCategory | null,
): value is Exclude<MemoryCategory, 'memory' | 'episode'> {
  return value === 'belief' || value === 'question' || value === 'guidance';
}

export function timelineDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function memoryNodeFingerprint(input: {
  readonly category: MemoryCategory;
  readonly sourceDate: string;
  readonly parentKey: string;
  readonly tags: readonly string[];
  readonly text: string;
}): string {
  return timelineDigest({
    category: input.category,
    sourceDate: input.sourceDate,
    parentKey: input.parentKey,
    tags: [...input.tags].sort(),
    text: input.text,
  });
}

export function timelineNodeFingerprint(entry: CanonicalMemoryNode, text = entry.node.content.text): string {
  return memoryNodeFingerprint({
    category: entry.category,
    sourceDate: entry.sourceDate,
    parentKey: entry.category === 'memory' ? `date:${entry.sourceDate}` : entry.node.parentId ?? '',
    tags: entry.node.tags,
    text,
  });
}

export function timelineNodeStateFingerprint(
  nodeId: string,
  projection: DocumentProjection,
  graph = canonicalMemoryGraph(projection),
): string | null {
  const node = nodeIndex(projection).get(nodeId);
  if (!node) return null;
  const canonical = graph.nodes.find((entry) => entry.node.id === nodeId);
  return timelineDigest({
    id: node.id,
    parentId: node.parentId ?? null,
    children: node.children,
    tags: [...node.tags].sort(),
    text: node.content.text,
    category: canonical?.category ?? null,
    sourceDate: canonical?.sourceDate ?? null,
  });
}

export function timelineSubtreeFingerprint(nodeId: string, projection: DocumentProjection): string | null {
  const index = nodeIndex(projection);
  if (!index.has(nodeId)) return null;
  const nodes: Array<{
    id: string;
    parentId: string | null;
    children: readonly string[];
    tags: readonly string[];
    text: string;
  }> = [];
  const stack = [nodeId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const node = index.get(currentId);
    if (!node) continue;
    nodes.push({
      id: node.id,
      parentId: node.parentId ?? null,
      children: node.children,
      tags: [...node.tags].sort(),
      text: node.content.text,
    });
    stack.push(...node.children);
  }
  return timelineDigest(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}

function publicationMarker(): Change {
  const definition = MEMORY_TAG_DEFINITIONS[0]!;
  return {
    op: 'ensure',
    resource: 'definition',
    definitionType: 'tag',
    id: definition.tagId,
    name: definition.name,
    bind: 'memoryPublicationMarker',
  };
}

function planUpsertTaggedNode(
  operations: Change[],
  index: ReadonlyMap<string, NodeProjection>,
  parent: TargetRef,
  nodeId: string,
  text: string,
  category: Exclude<MemoryCategory, 'memory'>,
  bind: string,
): TargetRef {
  const node = index.get(nodeId);
  if (!node) {
    operations.push(createTaggedChange(nodeId, parent, text, memoryTagId(category), bind));
    return binding(bind);
  }
  const changes: UpdateInstruction[] = [];
  if (node.content.text !== text) changes.push({ kind: 'content', value: plainText(text) });
  if (!node.tags.includes(memoryTagId(category))) {
    changes.push({ kind: 'tag', action: 'add', tag: oneId(memoryTagId(category)) });
  }
  if (changes.length > 0) operations.push({ op: 'update', targets: oneId(nodeId), changes });
  return oneId(nodeId);
}

function createTaggedChange(
  nodeId: string,
  parent: TargetRef,
  text: string,
  tagId: string,
  bind: string,
): Change {
  return {
    op: 'create',
    parents: parent,
    index: null,
    nodes: [{ id: nodeId, content: plainText(text), tags: [tagId], children: [] }],
    bind,
  };
}

function updateTextChange(nodeId: string, text: string): Change {
  return {
    op: 'update',
    targets: oneId(nodeId),
    changes: [{ kind: 'content', value: plainText(text) }],
  };
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function binding(name: string): TargetRef {
  return { binding: name };
}

function nodeIndex(projection: DocumentProjection): Map<string, NodeProjection> {
  return new Map(projection.nodes.map((node) => [node.id, node]));
}

function nodeDepth(nodeId: string, projection: DocumentProjection): number {
  const index = nodeIndex(projection);
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

function isDayNodeInsideDailyNotes(node: NodeProjection, index: ReadonlyMap<string, NodeProjection>): boolean {
  if (!node.tags.includes(TAG_DAY_ID)) return false;
  let current: NodeProjection | undefined = node;
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === DAILY_NOTES_ID) return true;
    visited.add(current.id);
    current = index.get(current.parentId);
  }
  return false;
}


function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
