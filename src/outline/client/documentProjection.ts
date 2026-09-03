import type {
  OutlineEvent,
  Projection,
  ProjectionResult,
} from '../contract/schemas';

export interface OutlineProjectionNode {
  readonly id: string;
}

export type OutlineDocumentProjection<TNode extends OutlineProjectionNode = OutlineProjectionNode> =
  ProjectionResult['anchors'] & { nodes: TNode[] };

export interface OutlineProjectionSnapshot<TNode extends OutlineProjectionNode = OutlineProjectionNode> {
  readonly revision: number;
  readonly projection: OutlineDocumentProjection<TNode>;
}

export type OutlineProjectionUpdate<TNode extends OutlineProjectionNode = OutlineProjectionNode> =
  | { readonly kind: 'full'; readonly revision: number; readonly projection: OutlineDocumentProjection<TNode> }
  | {
    readonly kind: 'delta';
    readonly revision: number;
    readonly todayId: string;
    readonly changedNodes: TNode[];
    readonly removedIds: string[];
  };

const FULL_PROJECTION_PAGE_SIZE = 10_000;
const FULL_PROJECTION_MAX_NODES = 1_000_000;
const FULL_PROJECTION_INCLUDE = [
  'description',
  'children',
  'tags',
  'fields',
  'references',
  'media',
  'view',
  'trash',
] as const;

export type OutlineProjectionRequest = <TResult>(command: string, input: unknown) => Promise<TResult>;

export async function readCompleteDocumentProjection<TNode extends OutlineProjectionNode = OutlineProjectionNode>(
  request: OutlineProjectionRequest,
): Promise<OutlineProjectionSnapshot<TNode>> {
  const nodes: TNode[] = [];
  let first: ProjectionResult | null = null;
  let cursor: string | undefined;
  do {
    const result = await request<ProjectionResult>('get', {
      selector: { by: 'alias', alias: 'home' },
      projection: fullDocumentProjection(cursor),
    });
    assertProjectionResult(result);
    if (!first) first = result;
    else if (result.revision !== first.revision) {
      throw new Error('Outline Runtime changed revision while reading the complete Projection.');
    }
    nodes.push(...result.nodes as TNode[]);
    if (nodes.length > FULL_PROJECTION_MAX_NODES) {
      throw new Error('Outline Runtime Projection exceeds the supported Node limit.');
    }
    cursor = result.truncated ? result.cursor : undefined;
    if (result.truncated && !cursor) {
      throw new Error('Outline Runtime returned a truncated Projection without a cursor.');
    }
  } while (cursor);

  if (!first) throw new Error('Outline Runtime returned no Projection page.');
  return {
    revision: first.revision,
    projection: {
      ...first.anchors,
      nodes,
    },
  };
}

export function projectionUpdateFromOutlineEvent<TNode extends OutlineProjectionNode = OutlineProjectionNode>(
  event: OutlineEvent,
): OutlineProjectionUpdate<TNode> | null {
  if (!event.changes) return null;
  if (!Array.isArray(event.changes.changedNodes) || !Array.isArray(event.changes.removedIds)) {
    throw new Error('Outline Runtime Event changes are invalid.');
  }
  return {
    kind: 'delta',
    revision: event.revision,
    todayId: event.changes.todayId,
    changedNodes: event.changes.changedNodes as TNode[],
    removedIds: event.changes.removedIds,
  };
}

export function applyProjectionUpdate<TNode extends OutlineProjectionNode>(
  projection: OutlineDocumentProjection<TNode>,
  update: OutlineProjectionUpdate<TNode>,
): OutlineDocumentProjection<TNode> {
  if (update.kind === 'full') return update.projection;
  const changedById = new Map(update.changedNodes.map((node) => [node.id, node]));
  const removed = new Set(update.removedIds);
  const nodes = projection.nodes.flatMap((node) => {
    if (removed.has(node.id)) return [];
    const changed = changedById.get(node.id);
    if (!changed) return [node];
    changedById.delete(node.id);
    return [changed];
  });
  nodes.push(...changedById.values());
  return {
    ...projection,
    todayId: update.todayId,
    nodes,
  };
}

export function fullDocumentProjection(cursor?: string): Projection {
  return {
    kind: 'outline',
    targets: {
      target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' },
    },
    depth: 1_024,
    include: [...FULL_PROJECTION_INCLUDE],
    page: {
      limit: FULL_PROJECTION_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    },
  };
}

function assertProjectionResult(value: ProjectionResult): void {
  if (!value
    || typeof value !== 'object'
    || !Number.isSafeInteger(value.revision)
    || !value.anchors
    || !Array.isArray(value.nodes)) {
    throw new Error('Outline Runtime returned an invalid Projection.');
  }
}
