import type { NodeId, NodeProjection } from '../../api/types';

export interface FieldOption {
  id: NodeId;
  label: string;
  autoCollected: boolean;
}

export function isOptionsFieldType(fieldType: NodeProjection['fieldType'] | undefined): boolean {
  return fieldType === 'options' || fieldType === 'options_from_supertag';
}

export function resolveFieldOptions(
  field: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): FieldOption[] {
  if (!field || !isOptionsFieldType(field.fieldType)) return [];
  return field.children
    .map((childId) => byId.get(childId))
    .filter((node): node is NodeProjection => Boolean(node))
    .map((node) => ({
      id: node.id,
      label: node.content.text || 'Untitled',
      autoCollected: node.autoCollected,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

export function filterFieldOptions(options: readonly FieldOption[], query: string): FieldOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(normalized));
}

export function resolveSelectedOptionId(
  valueNode: NodeProjection | undefined,
  options: readonly FieldOption[],
): NodeId | undefined {
  if (!valueNode) return undefined;
  if (valueNode.targetId && options.some((option) => option.id === valueNode.targetId)) {
    return valueNode.targetId;
  }
  const raw = valueNode.content.text.trim();
  if (!raw) return undefined;
  return options.find((option) => option.id === raw || option.label === raw)?.id;
}
