import { createHash } from 'node:crypto';
import {
  MEMORY_DOCUMENT_NAMESPACE,
  MEMORY_TAG_DEFINITIONS,
  memoryCategoryForTagId,
  memoryTagId,
  type MemoryCategory,
} from '../../../../core/agent/memory';
import type {
  DocumentSystemHost,
  DocumentSystemReceipt,
  DocumentSystemTransaction,
} from '../../../../core/documentSystem';
import {
  DAILY_NOTES_ID,
  TAG_DAY_ID,
  TRASH_ID,
  plainText,
  replaceAllRichTextPatch,
  type DocumentProjection,
  type NodeProjection,
} from '../../../../core/types';
import { nodeIsInSubtree } from '../../../../core/treeUtils';
import { Mutex } from '../../Mutex';

export const MEMORY_RECEIPT_SCOPE = DAILY_NOTES_ID;

export interface TimelineMemoryHost extends DocumentSystemHost {
  getProjection(): DocumentProjection;
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
    await this.withWriteGate(() => this.document.transaction({
        namespace: MEMORY_DOCUMENT_NAMESPACE,
        operationId: 'memory:ensure-tags',
      }, async (transaction) => {
        for (const definition of MEMORY_TAG_DEFINITIONS) {
          await transaction.executeHostCommand('ensure_document_system_tag_definition', {
            definition: {
              namespace: definition.namespace,
              tagId: definition.tagId,
              name: definition.name,
            },
          });
        }
      }));
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
    const receipt = publicationReceipt(publication);
    await beforeCommit?.();
    await this.document.transaction({
        namespace: MEMORY_DOCUMENT_NAMESPACE,
        operationId: publication.operationId,
      }, async (transaction) => {
        for (const date of publication.dates) {
          const [year, month, day] = date.sourceDate.split('-').map(Number) as [number, number, number];
          const outcome = await transaction.executeDocumentCommand('ensure_date_node', { year, month, day }) as {
            focus?: { nodeId?: string };
          };
          const dateNodeId = outcome.focus?.nodeId;
          if (!dateNodeId) throw new Error(`Unable to ensure Daily Note for Memory source date: ${date.sourceDate}`);
          const current = this.document.getProjection();
          const index = nodeIndex(current);
          const container = index.get(date.containerId);
          if (!container) {
            await createTaggedNode(transaction, date.containerId, dateNodeId, date.headline, memoryTagId('memory'));
          } else if (date.containerGenerated && container.content.text !== date.headline) {
            await transaction.executeDocumentCommand('apply_node_text_patch', {
              nodeId: date.containerId,
              patch: replaceAllRichTextPatch(plainText(date.headline)),
            });
          }
          await upsertTaggedTextNode(transaction, this.document, date.containerId, date.episodeId, date.episode, 'episode');
          for (const [position, text] of date.beliefs.entries()) {
            await upsertTaggedTextNode(transaction, this.document, date.episodeId, date.beliefIds[position]!, text, 'belief');
          }
          for (const [position, text] of date.questions.entries()) {
            await upsertTaggedTextNode(transaction, this.document, date.episodeId, date.questionIds[position]!, text, 'question');
          }
          for (const [position, text] of date.guidance.entries()) {
            await upsertTaggedTextNode(transaction, this.document, date.episodeId, date.guidanceIds[position]!, text, 'guidance');
          }
        }
        await transaction.executeHostCommand('put_document_system_receipt', { receipt });
      });
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
    const receipt: DocumentSystemReceipt = {
      namespace: MEMORY_DOCUMENT_NAMESPACE,
      scopeId: MEMORY_RECEIPT_SCOPE,
      operationId,
      generation,
      digest,
    };
    await beforeCommit?.();
    await this.document.transaction({ namespace: MEMORY_DOCUMENT_NAMESPACE, operationId }, async (transaction) => {
        const pendingCreates = changes.filter((change) => change.action === 'create');
        const created = new Set<string>();
        while (created.size < pendingCreates.length) {
          let progressed = false;
          for (const change of pendingCreates) {
            if (created.has(change.nodeId)) continue;
            const parentExists = nodeIndex(this.document.getProjection()).has(change.parentId)
              || created.has(change.parentId);
            if (!parentExists) continue;
            await createTaggedNode(
              transaction,
              change.nodeId,
              change.parentId,
              change.text,
              memoryTagId(change.category),
            );
            created.add(change.nodeId);
            progressed = true;
          }
          if (!progressed) throw new Error('Memory consolidation create graph has an unresolved parent');
        }
        for (const change of changes) {
          if (change.action === 'create') continue;
          const node = nodeIndex(this.document.getProjection()).get(change.nodeId);
          if (!node) continue;
          if (change.action === 'update') {
            await transaction.executeDocumentCommand('apply_node_text_patch', {
              nodeId: change.nodeId,
              patch: replaceAllRichTextPatch(plainText(change.text ?? '')),
            });
          }
        }
        const deletes = changes
          .filter((change) => change.action === 'delete')
          .sort((left, right) => nodeDepth(right.nodeId, this.document.getProjection())
            - nodeDepth(left.nodeId, this.document.getProjection()));
        for (const change of deletes) {
          if (nodeIndex(this.document.getProjection()).has(change.nodeId)) {
            await transaction.executeDocumentCommand('delete_node', { nodeId: change.nodeId });
          }
        }
        await transaction.executeHostCommand('put_document_system_receipt', { receipt });
      });
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
    const receipt: DocumentSystemReceipt = {
      namespace: MEMORY_DOCUMENT_NAMESPACE,
      scopeId: MEMORY_RECEIPT_SCOPE,
      operationId,
      generation,
      digest,
    };
    await this.document.transaction({ namespace: MEMORY_DOCUMENT_NAMESPACE, operationId }, async (transaction) => {
      const canonicalContainers = new Set(this.graph().containers.map((entry) => entry.node.id));
      for (const nodeId of containerIds) {
        if (!canonicalContainers.has(nodeId)) continue;
        await transaction.executeDocumentCommand('delete_node', { nodeId });
      }
      await transaction.executeHostCommand('put_document_system_receipt', { receipt });
    });
  }

  async receipt(): Promise<DocumentSystemReceipt | null> {
    return this.document.readDocumentSystemReceipt(MEMORY_DOCUMENT_NAMESPACE, MEMORY_RECEIPT_SCOPE);
  }

  visibleNodes(view: MemoryVisibilityView, generatedNodeIds: ReadonlySet<string>): readonly CanonicalMemoryNode[] {
    return this.graph().nodes.filter((entry) => {
      if (!generatedNodeIds.has(entry.node.id)) return true;
      return !view.suppressAllGenerated && !view.suppressedGeneratedNodeIds.has(entry.node.id);
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

function publicationReceipt(publication: TimelinePublication): DocumentSystemReceipt {
  return {
    namespace: MEMORY_DOCUMENT_NAMESPACE,
    scopeId: MEMORY_RECEIPT_SCOPE,
    operationId: publication.operationId,
    generation: publication.generation,
    digest: publication.digest,
  };
}

async function upsertTaggedTextNode(
  transaction: DocumentSystemTransaction,
  document: TimelineMemoryHost,
  parentId: string,
  nodeId: string,
  text: string,
  category: Exclude<MemoryCategory, 'memory'>,
): Promise<void> {
  const node = nodeIndex(document.getProjection()).get(nodeId);
  if (!node) {
    await createTaggedNode(transaction, nodeId, parentId, text, memoryTagId(category));
    return;
  }
  if (node.content.text !== text) {
    await transaction.executeDocumentCommand('apply_node_text_patch', {
      nodeId,
      patch: replaceAllRichTextPatch(plainText(text)),
    });
  }
  if (!node.tags.includes(memoryTagId(category))) {
    await transaction.executeDocumentCommand('apply_tag', { nodeId, tagId: memoryTagId(category) });
  }
}

async function createTaggedNode(
  transaction: DocumentSystemTransaction,
  nodeId: string,
  parentId: string,
  text: string,
  tagId: string,
): Promise<void> {
  await transaction.executeDocumentCommand('create_node', { id: nodeId, parentId, index: null, text });
  await transaction.executeDocumentCommand('apply_tag', { nodeId, tagId });
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
