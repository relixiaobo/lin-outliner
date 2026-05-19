import type { NodeId, NodeProjection } from '../../api/types';
import { isOptionsFieldType } from '../fields/fieldTypeRegistry';

export interface FieldOption {
  id: NodeId;
  label: string;
  autoCollected: boolean;
  targetId: NodeId;
}

export function resolveFieldOptions(
  field: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): FieldOption[] {
  if (!field || !isOptionsFieldType(field.fieldType)) return [];

  const optionNodes = field.fieldType === 'options_from_supertag'
    ? resolveOptionsFromSourceSupertag(field, byId)
    : field.children
      .map((childId) => byId.get(childId))
      .filter((node): node is NodeProjection => Boolean(node));

  const options = dedupeOptions(optionNodes.flatMap((node) => {
    const target = node.type === 'reference' && node.targetId ? byId.get(node.targetId) : node;
    if (!target) return [];
    return [{
      id: node.id,
      label: target.content.text || 'Untitled',
      autoCollected: node.autoCollected,
      targetId: target.id,
    }];
  }));

  return field.fieldType === 'options_from_supertag'
    ? options.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    : options;
}

function resolveOptionsFromSourceSupertag(
  field: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): NodeProjection[] {
  const sourceSupertag = field.sourceSupertag;
  if (!sourceSupertag) return [];
  return [...byId.values()].filter((node) => (
    node.id !== field.id
    && (!node.type || node.type === 'codeBlock')
    && node.tags.includes(sourceSupertag)
  ));
}

function dedupeOptions(options: FieldOption[]): FieldOption[] {
  const seen = new Set<NodeId>();
  const result: FieldOption[] = [];
  for (const option of options) {
    if (seen.has(option.targetId)) continue;
    seen.add(option.targetId);
    result.push(option);
  }
  return result;
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
  if (valueNode.targetId) {
    return options.find((option) => option.id === valueNode.targetId || option.targetId === valueNode.targetId)?.id;
  }
  const raw = valueNode.content.text.trim();
  if (!raw) return undefined;
  return options.find((option) => option.id === raw || option.targetId === raw)?.id;
}
