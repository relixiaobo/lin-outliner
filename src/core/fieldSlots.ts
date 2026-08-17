import { TRASH_ID, type DefConfigKey, type NodeId, type NodeType } from './types';

export interface FieldSlotNode {
  readonly id: NodeId;
  readonly type?: NodeType;
  readonly parentId?: NodeId | null;
  readonly children: readonly NodeId[];
  readonly tags?: readonly NodeId[];
  readonly fieldDefId?: NodeId;
  readonly configKey?: DefConfigKey;
  readonly targetId?: NodeId;
}

export type FieldSlotSource =
  | ReadonlyMap<NodeId, FieldSlotNode>
  | { readonly nodes: Readonly<Record<NodeId, FieldSlotNode>> };

export interface NodeFieldSlot {
  readonly id: NodeId;
  readonly fieldDefId: NodeId;
  readonly source: 'tag' | 'own';
  readonly sourceTagId?: NodeId;
  readonly templateEntryId?: NodeId;
  readonly entryId?: NodeId;
}

export interface FieldSlotValueSource {
  readonly entryId: NodeId;
  readonly inherited: boolean;
}

interface CachedSlots {
  readonly node: FieldSlotNode;
  readonly directChildren: readonly (FieldSlotNode | undefined)[];
  readonly schemaEpoch: number;
  readonly trashEpoch: number;
  readonly slots: readonly NodeFieldSlot[];
}

/**
 * Slots depend on the owner, its direct child entries, and the Schema subtree.
 * Object identity catches local changes; schemaEpoch invalidates unchanged
 * owners after a tag template, field definition, or extends chain changes,
 * while trashEpoch covers deletion state inherited from any ancestor.
 */
export class NodeFieldSlotCache {
  private readonly entries = new Map<NodeId, CachedSlots>();

  read(
    source: FieldSlotSource,
    nodeId: NodeId,
    schemaEpoch: number,
    trashEpoch: number,
  ): readonly NodeFieldSlot[] {
    const node = fieldSlotNode(source, nodeId);
    if (!node) return [];
    const cached = this.entries.get(nodeId);
    if (
      cached?.node === node
      && cached.schemaEpoch === schemaEpoch
      && cached.trashEpoch === trashEpoch
      && directChildrenMatch(source, node, cached.directChildren)
    ) return cached.slots;
    const slots = nodeFieldSlots(source, nodeId);
    const directChildren = node.children.map((childId) => fieldSlotNode(source, childId));
    this.entries.set(nodeId, { node, directChildren, schemaEpoch, trashEpoch, slots });
    return slots;
  }

  clear(): void {
    this.entries.clear();
  }
}

function directChildrenMatch(
  source: FieldSlotSource,
  owner: FieldSlotNode,
  cachedChildren: readonly (FieldSlotNode | undefined)[],
): boolean {
  if (owner.children.length !== cachedChildren.length) return false;
  return owner.children.every((childId, index) => (
    fieldSlotNode(source, childId) === cachedChildren[index]
  ));
}

export function fieldSlotId(ownerId: NodeId, fieldDefId: NodeId): NodeId {
  return `slot:${encodeURIComponent(ownerId)}:${encodeURIComponent(fieldDefId)}`;
}

export function parseFieldSlotId(id: NodeId): { ownerId: NodeId; fieldDefId: NodeId } | null {
  if (!id.startsWith('slot:')) return null;
  const parts = id.split(':');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  try {
    return {
      ownerId: decodeURIComponent(parts[1]),
      fieldDefId: decodeURIComponent(parts[2]),
    };
  } catch {
    return null;
  }
}

export function nodeFieldSlotById(source: FieldSlotSource, id: NodeId): NodeFieldSlot | undefined {
  const parsed = parseFieldSlotId(id);
  if (!parsed) return undefined;
  return nodeFieldSlots(source, parsed.ownerId)
    .find((slot) => slot.id === id && slot.fieldDefId === parsed.fieldDefId);
}

/**
 * Resolve the entry whose children a field presents as its value. A stored
 * entry always wins. An empty projected slot may instead read its tag template
 * entry as an inherited static default, unless that field has an acquisition-
 * time auto-initialize strategy. The returned template id is read-only
 * provenance: callers must never expose it as an instance-owned write target.
 */
export function fieldSlotValueSource(
  source: FieldSlotSource,
  slot: NodeFieldSlot,
): FieldSlotValueSource | undefined {
  if (slot.entryId) {
    const entry = fieldSlotNode(source, slot.entryId);
    return entry?.type === 'fieldEntry' && !fieldSlotNodeIsDeleted(source, entry.id)
      ? { entryId: entry.id, inherited: false }
      : undefined;
  }
  if (
    slot.source !== 'tag'
    || !slot.templateEntryId
    || fieldDefinitionHasAutoInitialize(source, slot.fieldDefId)
  ) return undefined;

  const templateEntry = fieldSlotNode(source, slot.templateEntryId);
  if (
    templateEntry?.type !== 'fieldEntry'
    || fieldSlotNodeIsDeleted(source, templateEntry.id)
    || !templateEntry.children.some((childId) => (
      Boolean(fieldSlotNode(source, childId))
      && !fieldSlotNodeIsDeleted(source, childId)
    ))
  ) return undefined;
  return { entryId: templateEntry.id, inherited: true };
}

export function fieldSlotHasInheritedDefault(
  source: FieldSlotSource,
  slot: NodeFieldSlot,
): boolean {
  return fieldSlotValueSource(source, slot)?.inherited === true;
}

/**
 * Return a node's complete ordered field shape. Tag-defined slots lead in tag
 * order, ancestor-first within each extends chain; remaining stored entries
 * retain their own child order. The first stored entry for a projected
 * fieldDef fills that tag slot and concurrent duplicates remain honest own rows.
 */
export function nodeFieldSlots(source: FieldSlotSource, nodeId: NodeId): readonly NodeFieldSlot[] {
  const owner = fieldSlotNode(source, nodeId);
  if (!owner || fieldSlotNodeIsDeleted(source, owner.id)) return [];

  const storedEntries = owner.children
    .map((childId) => fieldSlotNode(source, childId))
    .filter((child): child is FieldSlotNode => (
      child?.type === 'fieldEntry'
      && Boolean(child.fieldDefId)
      && !fieldSlotNodeIsDeleted(source, child.id)
    ));
  const storedByDefinition = new Map<NodeId, FieldSlotNode[]>();
  for (const entry of storedEntries) {
    const entries = storedByDefinition.get(entry.fieldDefId!) ?? [];
    entries.push(entry);
    storedByDefinition.set(entry.fieldDefId!, entries);
  }

  const slots: NodeFieldSlot[] = [];
  const projectedDefinitions = new Set<NodeId>();
  const consumedEntries = new Set<NodeId>();
  for (const appliedTagId of owner.tags ?? []) {
    const chain = tagDefinitionChainSpecificFirst(source, appliedTagId);
    for (let chainIndex = chain.length - 1; chainIndex >= 0; chainIndex -= 1) {
      const sourceTagId = chain[chainIndex]!;
      const tag = fieldSlotNode(source, sourceTagId);
      if (!tag) continue;
      for (const templateEntryId of tag.children) {
        const templateEntry = fieldSlotNode(source, templateEntryId);
        const fieldDefId = templateEntry?.type === 'fieldEntry'
          ? templateEntry.fieldDefId
          : undefined;
        if (
          !fieldDefId
          || projectedDefinitions.has(fieldDefId)
          || fieldSlotNodeIsDeleted(source, templateEntryId)
          || !activeFieldDefinition(source, fieldDefId)
        ) continue;
        projectedDefinitions.add(fieldDefId);
        const storedEntry = storedByDefinition.get(fieldDefId)?.find((entry) => !consumedEntries.has(entry.id));
        if (storedEntry) consumedEntries.add(storedEntry.id);
        slots.push({
          id: fieldSlotId(owner.id, fieldDefId),
          fieldDefId,
          source: 'tag',
          sourceTagId,
          templateEntryId,
          ...(storedEntry ? { entryId: storedEntry.id } : {}),
        });
      }
    }
  }

  for (const entry of storedEntries) {
    if (consumedEntries.has(entry.id)) continue;
    slots.push({
      id: entry.id,
      fieldDefId: entry.fieldDefId!,
      source: 'own',
      entryId: entry.id,
    });
  }
  return slots;
}

export function fieldSlotNode(source: FieldSlotSource, nodeId: NodeId): FieldSlotNode | undefined {
  return 'nodes' in source ? source.nodes[nodeId] : source.get(nodeId);
}

export function fieldSlotNodeIsDeleted(source: FieldSlotSource, nodeId: NodeId): boolean {
  const visited = new Set<NodeId>();
  let currentId: NodeId | null | undefined = nodeId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === TRASH_ID) return true;
    visited.add(currentId);
    currentId = fieldSlotNode(source, currentId)?.parentId;
  }
  return false;
}

function activeTagDefinition(source: FieldSlotSource, nodeId: NodeId): boolean {
  const node = fieldSlotNode(source, nodeId);
  return node?.type === 'tagDef' && !fieldSlotNodeIsDeleted(source, nodeId);
}

function activeFieldDefinition(source: FieldSlotSource, nodeId: NodeId): boolean {
  if (nodeId.startsWith('sys:')) return true;
  const node = fieldSlotNode(source, nodeId);
  return node?.type === 'fieldDef' && !fieldSlotNodeIsDeleted(source, nodeId);
}

function fieldDefinitionHasAutoInitialize(source: FieldSlotSource, fieldDefId: NodeId): boolean {
  const fieldDef = fieldSlotNode(source, fieldDefId);
  if (fieldDef?.type !== 'fieldDef') return false;
  const row = fieldDef.children
    .map((childId) => fieldSlotNode(source, childId))
    .find((child) => child?.type === 'defConfig' && child.configKey === 'autoInitialize');
  return Boolean(row?.children.some((childId) => {
    const value = fieldSlotNode(source, childId);
    return value?.type === 'reference'
      && Boolean(value.targetId)
      && !fieldSlotNodeIsDeleted(source, value.id);
  }));
}

export function tagDefinitionChainSpecificFirst(source: FieldSlotSource, tagId: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  const visited = new Set<NodeId>();
  let current: NodeId | undefined = tagId;
  while (current && !visited.has(current) && activeTagDefinition(source, current)) {
    visited.add(current);
    chain.push(current);
    current = tagExtendsTarget(source, current);
  }
  return chain;
}

/**
 * Return the structural tag chain even while one of its definitions is in
 * Trash. Dependency indexes use this variant so a restore can still find and
 * refresh owners whose active projection temporarily lost the tag schema.
 */
export function tagDefinitionDependencyChainSpecificFirst(source: FieldSlotSource, tagId: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  const visited = new Set<NodeId>();
  let current: NodeId | undefined = tagId;
  while (current && !visited.has(current)) {
    const tag = fieldSlotNode(source, current);
    if (tag?.type !== 'tagDef') break;
    visited.add(current);
    chain.push(current);
    current = tagExtendsTarget(source, current);
  }
  return chain;
}

function tagExtendsTarget(source: FieldSlotSource, tagId: NodeId): NodeId | undefined {
  const tag = fieldSlotNode(source, tagId);
  const row = tag?.children
    .map((childId) => fieldSlotNode(source, childId))
    .find((child) => child?.type === 'defConfig' && child.configKey === 'extends');
  if (!row) return undefined;
  return row.children
    .map((childId) => fieldSlotNode(source, childId))
    .find((child) => child?.type === 'reference' && child.targetId)
    ?.targetId;
}
