import type { DocumentCommand } from '../../../../core/commands';
import {
  MEMORY_TAG_DEFINITIONS,
  memoryTagId,
} from '../../../../core/agent/memory';
import {
  TAG_DAY_ID,
  TRASH_ID,
  type DocumentProjection,
  type NodeId,
  type NodeProjection,
  type ProjectionUpdate,
} from '../../../../core/types';
import { collectDescendantIds, nodeIsInSubtree } from '../../../../core/treeUtils';
import {
  canonicalMemoryGraph,
  canonicalMemoryContainerAncestorFromIndex,
  canonicalMemoryNodeFromIndex,
  timelineNodeFingerprint,
  type CanonicalMemoryNode,
} from './TimelineMemoryStore';

export interface MemoryMutationIndexDelta {
  readonly changedNodes: readonly NodeProjection[];
  readonly removedIds: readonly NodeId[];
}

export interface MemoryMutationIndexUpdate {
  readonly affectedCanonicalNodeIds: ReadonlySet<NodeId>;
  readonly fullRebuild: boolean;
}

interface TransactionJournal {
  readonly originalNodes: Map<NodeId, NodeProjection | undefined>;
}

const RESERVED_TAG_IDS: ReadonlySet<NodeId> = new Set(MEMORY_TAG_DEFINITIONS.map((entry) => entry.tagId));
const HIERARCHY_TAG_IDS: ReadonlySet<NodeId> = new Set([
  TAG_DAY_ID,
  memoryTagId('memory'),
  memoryTagId('episode'),
]);

export class MemoryMutationIndex {
  private nodes = new Map<NodeId, NodeProjection>();
  private readonly owned = new Set<NodeId>();
  private readonly reservedTagged = new Set<NodeId>();
  private readonly protectedAncestorCounts = new Map<NodeId, number>();
  private readonly protectedPaths = new Map<NodeId, readonly NodeId[]>();
  private readonly activeDefinitionNameById = new Map<NodeId, string>();
  private readonly activeDefinitionsByName = new Map<string, Set<NodeId>>();
  private readonly canonicalById = new Map<NodeId, CanonicalMemoryNode>();
  private readonly canonicalDependenciesById = new Map<NodeId, readonly NodeId[]>();
  private readonly canonicalDependentsByAncestor = new Map<NodeId, Set<NodeId>>();
  private transaction: TransactionJournal | null = null;
  private fullRebuilds = 0;

  constructor(projection: DocumentProjection) {
    this.rebuild(projection);
  }

  fullRebuildCount(): number {
    return this.fullRebuilds;
  }

  beginTransaction(): void {
    if (this.transaction) throw new Error('Memory mutation index transaction is already active');
    this.transaction = { originalNodes: new Map() };
  }

  commitTransaction(): void {
    this.transaction = null;
  }

  rollbackTransaction(): void {
    const transaction = this.transaction;
    if (!transaction) return;
    this.transaction = null;
    const changedNodes: NodeProjection[] = [];
    const removedIds: NodeId[] = [];
    for (const [nodeId, node] of transaction.originalNodes) {
      if (node) changedNodes.push(node);
      else removedIds.push(nodeId);
    }
    this.applyDelta({ changedNodes, removedIds }, false);
  }

  applyProjectionUpdate(update: ProjectionUpdate): MemoryMutationIndexUpdate {
    if (update.kind === 'full') {
      const affected = new Set<NodeId>(this.canonicalById.keys());
      this.rebuild(update.projection);
      for (const nodeId of this.canonicalById.keys()) affected.add(nodeId);
      return { affectedCanonicalNodeIds: affected, fullRebuild: true };
    }
    return this.applyDelta(update);
  }

  applyTransactionChanges(delta: MemoryMutationIndexDelta): MemoryMutationIndexUpdate {
    return this.applyDelta(delta);
  }

  canonicalNode(nodeId: NodeId): CanonicalMemoryNode | undefined {
    return this.canonicalById.get(nodeId);
  }

  allCanonicalNodeIds(): ReadonlySet<NodeId> {
    return new Set(this.canonicalById.keys());
  }

  canonicalNodesInGraphOrder(): readonly CanonicalMemoryNode[] {
    const containers = [...this.canonicalById.values()]
      .filter((entry) => entry.category === 'memory')
      .sort((left, right) => left.node.id.localeCompare(right.node.id));
    const ordered: CanonicalMemoryNode[] = [];
    for (const container of containers) {
      ordered.push(container);
      for (const episodeId of container.node.children) {
        const episode = this.canonicalById.get(episodeId);
        if (
          !episode
          || episode.category !== 'episode'
          || episode.containerId !== container.node.id
        ) continue;
        ordered.push(episode);
        const queue = [...episode.node.children];
        const visited = new Set<NodeId>();
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (visited.has(nodeId)) continue;
          visited.add(nodeId);
          const node = this.nodes.get(nodeId);
          if (!node) continue;
          queue.push(...node.children);
          const entry = this.canonicalById.get(nodeId);
          if (
            entry
            && entry.category !== 'memory'
            && entry.category !== 'episode'
            && entry.containerId === container.node.id
            && entry.episodeId === episode.node.id
          ) ordered.push(entry);
        }
      }
    }
    return ordered;
  }

  mayChangeMemory(
    command: DocumentCommand,
    args: Readonly<Record<string, unknown>>,
    generatedNodeIds: ReadonlySet<NodeId>,
  ): boolean {
    if (this.commandUsesReservedTag(command, args)) return true;
    const direct = (key: string) => typeof args[key] === 'string' ? args[key] as string : null;
    const directArray = (key: string) => Array.isArray(args[key])
      ? (args[key] as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    const changesOwned = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
      nodeId !== null && this.owned.has(nodeId)
    ));
    const changesIdentity = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
      nodeId !== null && (this.owned.has(nodeId) || this.isProtectedAncestor(nodeId))
    ));
    const changesStructure = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
      nodeId !== null
      && (this.owned.has(nodeId) || this.reservedTagged.has(nodeId) || this.isProtectedAncestor(nodeId))
    ));
    const createsInsideMemory = (parentId: string | null) => parentId !== null && this.owned.has(parentId);
    const changesOwnedArray = (key: string) => directArray(key).some((nodeId) => changesOwned(nodeId));
    const changesStructureArray = (key: string) => directArray(key).some((nodeId) => changesStructure(nodeId));
    const changesDayIdentity = (...nodeIds: Array<string | null>) => direct('tagId') === TAG_DAY_ID
      && nodeIds.some((nodeId) => nodeId !== null && this.isProtectedAncestor(nodeId));
    const historyNodeIsProtected = (nodeId: string) => this.owned.has(nodeId)
      || this.reservedTagged.has(nodeId)
      || this.isProtectedAncestor(nodeId)
      || RESERVED_TAG_IDS.has(nodeId)
      || generatedNodeIds.has(nodeId);

    switch (command) {
      case 'get_projection':
      case 'search_nodes':
      case 'backlinks':
      case 'create_tag':
      case 'create_field_definition':
      case 'ensure_date_node':
      case 'ensure_tag_search':
        return false;
      case 'init_workspace':
        return this.owned.size > 0 || this.reservedTagged.size > 0;
      case 'create_node':
        return changesOwned(direct('id')) || createsInsideMemory(direct('parentId'));
      case 'create_rich_text_node':
      case 'create_tagged_node':
      case 'create_tag_and_tagged_node':
      case 'create_nodes_from_tree':
      case 'create_image_node':
      case 'create_attachment_node':
      case 'create_search_node':
        return createsInsideMemory(direct('parentId'));
      case 'create_capture': {
        const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
          ? args.input as Record<string, unknown>
          : {};
        return createsInsideMemory(typeof input.destinationParentId === 'string' ? input.destinationParentId : null);
      }
      case 'paste_nodes_into_node':
      case 'update_node_description':
      case 'set_node_checkbox_visible':
      case 'set_code_block':
      case 'set_code_language':
      case 'set_node_image':
      case 'set_view_toolbar_visible':
      case 'set_view_mode':
      case 'clear_sort_rules':
      case 'clear_filter_rules':
      case 'set_group_field':
      case 'add_display_field':
      case 'set_node_icon':
      case 'set_node_banner':
      case 'toggle_done':
      case 'cycle_done_state':
      case 'set_search_node':
      case 'set_search_query_outline':
      case 'refresh_search_node_results':
        return changesOwned(direct('nodeId'));
      case 'apply_node_text_patch':
        return changesIdentity(direct('nodeId'));
      case 'split_node':
        return changesStructure(direct('nodeId')) || createsInsideMemory(direct('targetParentId'));
      case 'add_sort_rule':
      case 'add_filter_rule':
        return changesOwned(direct('nodeId'), direct('field'));
      case 'update_sort_rule':
      case 'update_filter_rule':
      case 'remove_sort_rule':
      case 'remove_filter_rule':
        return changesOwned(direct('ruleId'), direct('field'));
      case 'update_display_field':
      case 'remove_display_field':
        return changesOwned(direct('displayFieldId'), direct('field'));
      case 'merge_node_into':
        return changesStructure(direct('nodeId'), direct('targetId'));
      case 'move_node':
        return changesStructure(direct('nodeId')) || createsInsideMemory(direct('parentId'));
      case 'batch_move_nodes':
        return Array.isArray(args.moves) && args.moves.some((move) => {
          if (!move || typeof move !== 'object' || Array.isArray(move)) return true;
          const entry = move as Record<string, unknown>;
          return changesStructure(typeof entry.nodeId === 'string' ? entry.nodeId : null)
            || createsInsideMemory(typeof entry.parentId === 'string' ? entry.parentId : null);
        });
      case 'indent_node': {
        const nodeId = direct('nodeId');
        const node = nodeId ? this.nodes.get(nodeId) : undefined;
        const siblings = node?.parentId ? this.nodes.get(node.parentId)?.children ?? [] : [];
        const position = node ? siblings.indexOf(node.id) : -1;
        const previousSiblingId = position > 0 ? siblings[position - 1] ?? null : null;
        return changesStructure(nodeId) || createsInsideMemory(previousSiblingId);
      }
      case 'outdent_node':
      case 'trash_node':
      case 'restore_node':
      case 'delete_node':
        return changesStructure(direct('nodeId'));
      case 'batch_trash_nodes':
      case 'batch_outdent_nodes':
      case 'batch_duplicate_nodes':
        return changesStructureArray('nodeIds');
      case 'batch_indent_nodes':
        return directArray('nodeIds').some((nodeId) => {
          const node = this.nodes.get(nodeId);
          const siblings = node?.parentId ? this.nodes.get(node.parentId)?.children ?? [] : [];
          const position = node ? siblings.indexOf(node.id) : -1;
          return changesStructure(nodeId) || createsInsideMemory(position > 0 ? siblings[position - 1] ?? null : null);
        });
      case 'batch_toggle_done':
      case 'batch_cycle_done_state':
      case 'batch_move_nodes_up':
      case 'batch_move_nodes_down':
        return changesOwnedArray('nodeIds');
      case 'batch_apply_tag':
        return changesOwnedArray('nodeIds') || changesDayIdentity(...directArray('nodeIds'));
      case 'apply_tag':
      case 'remove_tag':
        return changesOwned(direct('nodeId')) || changesDayIdentity(direct('nodeId'));
      case 'set_tag_config':
        return changesOwned(direct('tagId'));
      case 'set_field_config':
        return changesOwned(direct('fieldId'));
      case 'create_field_def':
        return changesOwned(direct('tagId'));
      case 'create_inline_field_after_node':
        return changesOwned(direct('afterNodeId'));
      case 'create_inline_field':
        return createsInsideMemory(direct('parentId')) || changesOwned(direct('targetDefId'));
      case 'update_field_slot':
        return changesOwned(direct('ownerId'), direct('fieldDefId'), direct('entryId'), direct('id'));
      case 'reuse_field_definition':
        return changesOwned(direct('entryId'), direct('targetDefId'));
      case 'merge_definitions':
        return changesOwned(direct('targetId')) || changesOwnedArray('sourceIds');
      case 'register_collected_option':
        return changesOwned(direct('fieldDefId'));
      case 'create_collected_field_option':
      case 'select_field_option':
      case 'set_field_free_text_value':
        return changesOwned(direct('fieldEntryId'), direct('id'));
      case 'clear_field_value':
        return changesOwned(direct('fieldEntryId'));
      case 'remove_field_value':
        return changesOwned(direct('valueId'));
      case 'add_reference':
      case 'add_reference_conversion':
        return createsInsideMemory(direct('parentId'));
      case 'set_reference_target':
        return changesOwned(direct('referenceId'));
      case 'replace_node_with_reference':
      case 'replace_node_with_reference_conversion':
      case 'replace_node_with_inline_reference':
      case 'restore_inline_reference_node_to_reference':
        return changesStructure(direct('nodeId'));
      case 'convert_reference_to_inline_node':
        return changesStructure(direct('referenceId'));
      case 'undo':
      case 'redo':
        return historyMutationMayChangeMemory(args.historyMutation, historyNodeIsProtected);
      default:
        return true;
    }
  }

  debugSnapshot(): {
    readonly owned: readonly NodeId[];
    readonly protectedAncestors: readonly NodeId[];
    readonly reservedTagged: readonly NodeId[];
    readonly canonical: readonly NodeId[];
    readonly canonicalFingerprints: readonly (readonly [NodeId, string])[];
  } {
    return {
      owned: [...this.owned].sort(),
      protectedAncestors: [...this.protectedAncestorCounts]
        .filter(([, count]) => count > 0)
        .map(([nodeId]) => nodeId)
        .sort(),
      reservedTagged: [...this.reservedTagged].sort(),
      canonical: [...this.canonicalById.keys()].sort(),
      canonicalFingerprints: [...this.canonicalById]
        .map(([nodeId, entry]) => [nodeId, timelineNodeFingerprint(entry)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    };
  }

  private rebuild(projection: DocumentProjection): void {
    this.nodes = new Map(projection.nodes.map((node) => [node.id, node]));
    this.owned.clear();
    this.reservedTagged.clear();
    this.protectedAncestorCounts.clear();
    this.protectedPaths.clear();
    this.activeDefinitionNameById.clear();
    this.activeDefinitionsByName.clear();
    this.canonicalById.clear();
    this.canonicalDependenciesById.clear();
    this.canonicalDependentsByAncestor.clear();

    for (const node of this.nodes.values()) this.addDirectDerivedState(node);
    const graph = canonicalMemoryGraph(projection);
    for (const container of graph.containers) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, container.node.id)) this.owned.add(nodeId);
    }
    for (const entry of graph.nodes) this.addCanonicalEntry(entry);
    this.fullRebuilds += 1;
  }

  private applyDelta(delta: MemoryMutationIndexDelta, recordTransaction = true): MemoryMutationIndexUpdate {
    if (delta.changedNodes.length === 0 && delta.removedIds.length === 0) {
      return { affectedCanonicalNodeIds: new Set(), fullRebuild: false };
    }
    const changedById = new Map(delta.changedNodes.map((node) => [node.id, node]));
    const directIds = new Set<NodeId>([...changedById.keys(), ...delta.removedIds]);
    const subtreeRoots = new Set<NodeId>();
    const affectedNodeIds = new Set<NodeId>(directIds);
    const affectedCanonicalNodeIds = this.canonicalDependents(directIds);

    for (const nodeId of directIds) {
      const before = this.nodes.get(nodeId);
      const after = changedById.get(nodeId);
      if (recordTransaction && this.transaction && !this.transaction.originalNodes.has(nodeId)) {
        this.transaction.originalNodes.set(nodeId, before);
      }
      if (subtreeIdentityChanged(before, after)) subtreeRoots.add(nodeId);
      for (const childId of changedChildIds(before, after)) subtreeRoots.add(childId);
    }
    for (const rootId of subtreeRoots) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, rootId)) affectedNodeIds.add(nodeId);
    }

    for (const nodeId of delta.removedIds) this.nodes.delete(nodeId);
    for (const node of delta.changedNodes) this.nodes.set(node.id, node);

    for (const rootId of subtreeRoots) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, rootId)) affectedNodeIds.add(nodeId);
    }
    for (const nodeId of affectedNodeIds) this.removeDerivedState(nodeId);
    for (const nodeId of affectedNodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) this.addDerivedState(node);
    }
    for (const nodeId of this.canonicalDependents(directIds)) affectedCanonicalNodeIds.add(nodeId);
    for (const nodeId of directIds) affectedCanonicalNodeIds.add(nodeId);

    return { affectedCanonicalNodeIds, fullRebuild: false };
  }

  private addDerivedState(node: NodeProjection): void {
    this.addDirectDerivedState(node);
    if (this.canonicalContainerAncestor(node.id)) this.owned.add(node.id);
    const canonical = canonicalMemoryNodeFromIndex(node, this.nodes);
    if (canonical) this.addCanonicalEntry(canonical);
  }

  private addDirectDerivedState(node: NodeProjection): void {
    if (node.tags.some((tagId) => RESERVED_TAG_IDS.has(tagId))) {
      this.reservedTagged.add(node.id);
      const path = ancestorIds(node.id, this.nodes);
      this.protectedPaths.set(node.id, path);
      for (const ancestorId of path) incrementCount(this.protectedAncestorCounts, ancestorId);
    }
    if (node.type === 'tagDef' && !nodeIsInSubtree(this.nodes, node.id, TRASH_ID)) {
      const name = definitionNameKey(node.content.text);
      if (name) {
        this.activeDefinitionNameById.set(node.id, name);
        addToSetMap(this.activeDefinitionsByName, name, node.id);
      }
    }
  }

  private removeDerivedState(nodeId: NodeId): void {
    this.owned.delete(nodeId);
    this.reservedTagged.delete(nodeId);
    const path = this.protectedPaths.get(nodeId);
    if (path) {
      for (const ancestorId of path) decrementCount(this.protectedAncestorCounts, ancestorId);
      this.protectedPaths.delete(nodeId);
    }
    const definitionName = this.activeDefinitionNameById.get(nodeId);
    if (definitionName) {
      removeFromSetMap(this.activeDefinitionsByName, definitionName, nodeId);
      this.activeDefinitionNameById.delete(nodeId);
    }
    this.removeCanonicalEntry(nodeId);
  }

  private addCanonicalEntry(entry: CanonicalMemoryNode): void {
    this.canonicalById.set(entry.node.id, entry);
    const dependencies = [entry.node.id, ...ancestorIds(entry.node.id, this.nodes)];
    this.canonicalDependenciesById.set(entry.node.id, dependencies);
    for (const ancestorId of dependencies) addToSetMap(this.canonicalDependentsByAncestor, ancestorId, entry.node.id);
  }

  private removeCanonicalEntry(nodeId: NodeId): void {
    this.canonicalById.delete(nodeId);
    const dependencies = this.canonicalDependenciesById.get(nodeId);
    if (!dependencies) return;
    for (const ancestorId of dependencies) removeFromSetMap(this.canonicalDependentsByAncestor, ancestorId, nodeId);
    this.canonicalDependenciesById.delete(nodeId);
  }

  private canonicalDependents(nodeIds: Iterable<NodeId>): Set<NodeId> {
    const dependents = new Set<NodeId>();
    for (const nodeId of nodeIds) {
      for (const dependentId of this.canonicalDependentsByAncestor.get(nodeId) ?? []) dependents.add(dependentId);
    }
    return dependents;
  }

  private canonicalContainerAncestor(nodeId: NodeId): NodeProjection | null {
    const node = this.nodes.get(nodeId);
    return node ? canonicalMemoryContainerAncestorFromIndex(node, this.nodes)?.node ?? null : null;
  }

  private isProtectedAncestor(nodeId: NodeId): boolean {
    return (this.protectedAncestorCounts.get(nodeId) ?? 0) > 0;
  }

  private commandUsesReservedTag(
    command: DocumentCommand,
    args: Readonly<Record<string, unknown>>,
  ): boolean {
    if (
      (command === 'create_tagged_node'
        || command === 'apply_tag'
        || command === 'remove_tag'
        || command === 'batch_apply_tag')
      && typeof args.tagId === 'string'
      && RESERVED_TAG_IDS.has(args.tagId)
    ) {
      return true;
    }
    const resolvesToReserved = (name: unknown, first: boolean) => {
      if (typeof name !== 'string') return false;
      const ids = this.activeDefinitionsByName.get(definitionNameKey(name));
      if (!ids || ids.size === 0) return false;
      let resolved: string | null = null;
      for (const id of ids) {
        if (resolved === null || (first ? id < resolved : id > resolved)) resolved = id;
      }
      return resolved !== null && RESERVED_TAG_IDS.has(resolved);
    };
    const materializedNameIsReserved = (name: unknown) => resolvesToReserved(name, false);
    switch (command) {
      case 'create_tag_and_tagged_node':
        return resolvesToReserved(args.name, true);
      case 'create_nodes_from_tree':
        return createNodeTreesUseReservedTag(args.nodes, materializedNameIsReserved);
      case 'paste_nodes_into_node':
        return pasteRowMetaUsesReservedTag(args.firstMeta, materializedNameIsReserved)
          || createNodeTreesUseReservedTag(args.children, materializedNameIsReserved)
          || createNodeTreesUseReservedTag(args.siblingsAfter, materializedNameIsReserved);
      default:
        return false;
    }
  }
}

function subtreeIdentityChanged(before: NodeProjection | undefined, after: NodeProjection | undefined): boolean {
  if (!before || !after) return true;
  if (before.parentId !== after.parentId) return true;
  if (before.content.text !== after.content.text && (before.tags.includes(TAG_DAY_ID) || after.tags.includes(TAG_DAY_ID))) {
    return true;
  }
  return !sameFilteredTags(before.tags, after.tags, HIERARCHY_TAG_IDS);
}

function changedChildIds(before: NodeProjection | undefined, after: NodeProjection | undefined): NodeId[] {
  const beforeChildren = new Set(before?.children ?? []);
  const afterChildren = new Set(after?.children ?? []);
  return [...beforeChildren, ...afterChildren].filter((nodeId) => beforeChildren.has(nodeId) !== afterChildren.has(nodeId));
}

function sameFilteredTags(
  before: readonly string[],
  after: readonly string[],
  relevant: ReadonlySet<string>,
): boolean {
  const beforeRelevant = before.filter((tagId) => relevant.has(tagId));
  const afterRelevant = after.filter((tagId) => relevant.has(tagId));
  if (beforeRelevant.length !== afterRelevant.length) return false;
  return beforeRelevant.every((tagId) => afterRelevant.includes(tagId));
}

function nodeAndDescendantIds(nodes: ReadonlyMap<NodeId, NodeProjection>, rootId: NodeId): Set<NodeId> {
  return new Set([rootId, ...collectDescendantIds(nodes, rootId)]);
}

function ancestorIds(nodeId: NodeId, nodes: ReadonlyMap<NodeId, NodeProjection>): NodeId[] {
  const ancestors: NodeId[] = [];
  const visited = new Set<NodeId>([nodeId]);
  let current = nodes.get(nodeId);
  while (current?.parentId && !visited.has(current.parentId)) {
    ancestors.push(current.parentId);
    visited.add(current.parentId);
    current = nodes.get(current.parentId);
  }
  return ancestors;
}

function historyMutationMayChangeMemory(
  value: unknown,
  nodeIsProtected: (nodeId: string) => boolean,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const context = value as Record<string, unknown>;
  if (context.status === 'none') return !Array.isArray(context.targets) || context.targets.length > 0;
  if (context.status !== 'known' || !Array.isArray(context.targets) || context.targets.length === 0) return true;
  for (const valueTarget of context.targets) {
    if (!valueTarget || typeof valueTarget !== 'object' || Array.isArray(valueTarget)) return true;
    const target = valueTarget as Record<string, unknown>;
    if (
      typeof target.operationId !== 'string'
      || !Array.isArray(target.affectedNodeIds)
      || !target.affectedNodeIds.every((nodeId) => typeof nodeId === 'string')
      || typeof target.affectedNodeCount !== 'number'
      || !Number.isInteger(target.affectedNodeCount)
      || target.affectedNodeCount < 0
      || target.affectedNodeCount !== target.affectedNodeIds.length
      || (target.affectedNodeIdsTruncated !== undefined && typeof target.affectedNodeIdsTruncated !== 'boolean')
      || target.affectedNodeIdsTruncated === true
      || typeof target.affectsMemory !== 'boolean'
    ) {
      return true;
    }
    if (target.affectsMemory || (target.affectedNodeIds as string[]).some(nodeIsProtected)) return true;
  }
  return false;
}

function createNodeTreesUseReservedTag(
  value: unknown,
  nameIsReserved: (name: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  const pending = [...value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tree = entry as Record<string, unknown>;
    if (pasteRowMetaUsesReservedTag(tree, nameIsReserved)) return true;
    if (Array.isArray(tree.children)) pending.push(...tree.children);
  }
  return false;
}

function pasteRowMetaUsesReservedTag(
  value: unknown,
  nameIsReserved: (name: unknown) => boolean,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tags = (value as Record<string, unknown>).tags;
  return Array.isArray(tags) && tags.some(nameIsReserved);
}

function definitionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function incrementCount(counts: Map<NodeId, number>, nodeId: NodeId): void {
  counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
}

function decrementCount(counts: Map<NodeId, number>, nodeId: NodeId): void {
  const next = (counts.get(nodeId) ?? 0) - 1;
  if (next > 0) counts.set(nodeId, next);
  else counts.delete(nodeId);
}

function addToSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}

function removeFromSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key);
  if (!values) return;
  values.delete(value);
  if (values.size === 0) map.delete(key);
}
