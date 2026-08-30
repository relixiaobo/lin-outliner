import {
  SOURCE_FIELD_ID,
  type FieldEntryNode,
  type Node,
  type NodeId,
  type NodeProjection,
} from './types';

type SourceFieldNode = Node | NodeProjection;
type SourceFieldSource =
  | ReadonlyMap<NodeId, SourceFieldNode>
  | { readonly nodes: Readonly<Record<NodeId, SourceFieldNode>> };

export interface SourceFieldValue {
  readonly entry: FieldEntryNode | Extract<NodeProjection, { type: 'fieldEntry' }>;
  readonly node: SourceFieldNode;
  readonly sourceText: string;
}

export function sourceFieldEntries(
  source: SourceFieldSource,
  ownerId: NodeId,
): Array<FieldEntryNode | Extract<NodeProjection, { type: 'fieldEntry' }>> {
  const owner = sourceNode(source, ownerId);
  if (!owner) return [];
  return owner.children.flatMap((childId) => {
    const child = sourceNode(source, childId);
    return child?.type === 'fieldEntry'
      && child.parentId === ownerId
      && child.fieldDefId === SOURCE_FIELD_ID
      ? [child]
      : [];
  });
}

export function sourceFieldValues(
  source: SourceFieldSource,
  ownerId: NodeId,
): SourceFieldValue[] {
  return sourceFieldEntries(source, ownerId).flatMap((entry) => (
    entry.children.flatMap((valueId) => {
      const node = sourceNode(source, valueId);
      return node?.parentId === entry.id
        ? [{ entry, node, sourceText: node.content.text }]
        : [];
    })
  ));
}

function sourceNode(source: SourceFieldSource, nodeId: NodeId): SourceFieldNode | undefined {
  return 'nodes' in source ? source.nodes[nodeId] : source.get(nodeId);
}
