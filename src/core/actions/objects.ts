// Building `SurfaceObject`s from the projection, and presenting them.
//
// The three node facets preserve ONE object, not three rows: structural actions
// keep acting on the occurrence, content actions on the target, and
// activation/pin on the drill-down surface — which is exactly what the shipped
// call sites pass as `targetId` and `openId` today.

import type { NodeId, NodeProjection } from '../types';
import { objectName, objectTypeLabel } from './names';
import { resolveReferenceChainTargetId } from './rowFacets';
import type {
  ActionProjection,
  LocalizedNames,
  NodeObject,
  NodeObjectRef,
  IconId,
  ObjectPresentation,
  ObjectRef,
  SurfaceObject,
  SystemNodeKey,
} from './types';

export type RefMinter = () => ObjectRef;


/** Semantic target of a row: a reference resolves through its whole chain. */
export function contentTargetId(
  rowId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId {
  const node = byId.get(rowId);
  if (node?.type === 'reference' && node.targetId) {
    const resolved = resolveReferenceChainTargetId(node.targetId, byId);
    if (resolved) return resolved;
  }
  return node ? node.id : rowId;
}

/** Activation target: a field entry activates its definition (the drill-down). */
export function canonicalSurfaceId(
  rowId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId {
  const node = byId.get(rowId);
  if (node?.type === 'fieldEntry') {
    return node.fieldDefId && byId.has(node.fieldDefId) ? node.fieldDefId : rowId;
  }
  return contentTargetId(rowId, byId);
}

export function nodeObjectForRow(
  rowId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  mintRef: RefMinter,
): NodeObject {
  return {
    kind: 'node',
    objectRef: mintRef(),
    row: { by: 'id', nodeId: rowId },
    content: { by: 'id', nodeId: contentTargetId(rowId, byId) },
    canonicalSurface: { by: 'id', nodeId: canonicalSurfaceId(rowId, byId) },
  };
}

export function nodeSelectionObject(
  nodes: readonly NodeObject[],
  mintRef: RefMinter,
): Extract<SurfaceObject, { kind: 'nodeSelection' }> {
  return { kind: 'nodeSelection', objectRef: mintRef(), nodes };
}

/** A system node object still resolves to a real document node id. */
export function systemNodeId(key: SystemNodeKey, projection: ActionProjection): NodeId {
  switch (key) {
    case 'today': return projection.todayId;
    case 'library': return projection.libraryId;
    case 'schema': return projection.schemaId;
    case 'savedSearches': return projection.searchesId;
    case 'trash': return projection.trashId;
  }
}

/** Resolve a node facet to a document id. `today` may not exist yet — see `open`. */
export function nodeIdForFacet(
  facet: NodeObjectRef,
  projection: ActionProjection,
): NodeId {
  return facet.by === 'id' ? facet.nodeId : systemNodeId(facet.key, projection);
}

export function systemKeyForFacet(facet: NodeObjectRef): SystemNodeKey | null {
  return facet.by === 'system' ? facet.key : null;
}

/** The untitled fallback is part of the differential proof for `copy`. */
export function nodeText(
  node: NodeProjection | undefined,
  untitled: string,
): string {
  if (!node) return untitled;
  if (node.type === 'reference' && node.targetId) return `@${node.targetId}`;
  return node.content.text || untitled;
}

const SYSTEM_OBJECT_ICONS: Record<SystemNodeKey, IconId> = {
  today: 'node',
  library: 'library',
  schema: 'schema',
  savedSearches: 'savedSearches',
  trash: 'trash',
};

const SYSTEM_OBJECT_NAMES: Record<SystemNodeKey, LocalizedNames> = {
  today: objectName('today'),
  library: objectName('library'),
  schema: objectName('schema'),
  savedSearches: objectName('savedSearches'),
  trash: objectName('trash'),
};

/** How main describes a captured page to the surface, without shipping context. */
export interface ExternalPageDescription {
  title: string;
  /** Where it is from — a hostname or app name. */
  subtitle?: string;
}

export function presentObject(
  object: SurfaceObject,
  projection: ActionProjection,
  untitled: string,
  describeExternalPage?: (contextId: string) => ExternalPageDescription | null,
): ObjectPresentation {
  switch (object.kind) {
    case 'node': {
      const systemKey = systemKeyForFacet(object.canonicalSurface);
      if (systemKey) {
        return {
          objectRef: object.objectRef,
          kind: 'node',
          name: { source: 'localized', values: SYSTEM_OBJECT_NAMES[systemKey] },
          // Each system node reads as ITSELF; one generic glyph for all five
          // makes the empty-query list a column of identical rows.
          iconId: SYSTEM_OBJECT_ICONS[systemKey],
          typeLabel: objectTypeLabel('node'),
        };
      }
      const contentId = nodeIdForFacet(object.content, projection);
      const node = projection.byId.get(contentId);
      const isAttachment = node?.type === 'attachment';
      // The parent's text disambiguates same-named nodes, which is the whole
      // reason the shipped launcher row carried a subtitle.
      const parent = node?.parentId ? projection.byId.get(node.parentId) : undefined;
      return {
        objectRef: object.objectRef,
        kind: 'node',
        name: { source: 'literal', value: nodeText(node, untitled) },
        // No subtitle at all for a parent with no text — the deleted matcher
        // omitted it, and a literal "Untitled" is noise, not disambiguation.
        ...(parent?.content.text ? { subtitle: { source: 'literal' as const, value: parent.content.text } } : {}),
        // Only a real emoji icon: an image / generated icon identifier is not
        // an emoji, and emitting it as one renders the raw id.
        ...(node?.icon && node.iconKind === 'emoji' ? { emoji: node.icon } : {}),
        iconId: isAttachment ? 'file' : 'node',
        typeLabel: objectTypeLabel(isAttachment ? 'file' : 'node'),
        backingNodeId: contentId,
      };
    }
    case 'nodeSelection':
      return {
        objectRef: object.objectRef,
        kind: 'nodeSelection',
        name: { source: 'literal', value: `${object.nodes.length}` },
        iconId: 'node',
        typeLabel: objectTypeLabel('nodeSelection'),
      };
    case 'externalPage': {
      // The chip is the same object presentation a result row uses, rendered
      // compactly — not a second "attached context" concept.
      const described = describeExternalPage?.(object.contextId);
      return {
        objectRef: object.objectRef,
        kind: 'externalPage',
        name: { source: 'literal', value: described?.title ?? untitled },
        ...(described?.subtitle
          ? { subtitle: { source: 'literal' as const, value: described.subtitle } }
          : {}),
        iconId: 'open',
        typeLabel: objectTypeLabel('externalPage'),
      };
    }
    case 'draft':
      return {
        objectRef: object.objectRef,
        kind: 'draft',
        name: { source: 'literal', value: object.text },
        iconId: object.purpose === 'tag' ? 'supertag' : 'node',
        typeLabel: objectTypeLabel(object.purpose === 'tag' ? 'draftTag' : 'draftNode'),
      };
    case 'appSurface':
      return {
        objectRef: object.objectRef,
        kind: 'appSurface',
        name: {
          source: 'localized',
          values: objectName(object.surface === 'settings' ? 'settings' : 'mainWindow'),
        },
        // By DISCRIMINANT. Comparing the English display string never matched
        // under a non-English locale, so the row got the wrong icon.
        iconId: object.surface === 'settings' ? 'settings' : 'mainWindow',
        typeLabel: objectTypeLabel('appSurface'),
      };
  }
}
