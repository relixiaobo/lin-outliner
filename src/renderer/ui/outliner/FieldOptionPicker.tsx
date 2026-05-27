import type { NodeId, NodeProjection } from '../../api/types';
import { resolveFieldOptions, resolveSelectedOptionId } from '../interactions/fieldOptions';
import { projectFieldConfig } from '../../../core/configProjection';
import { NodeValuePicker, type NodeValuePickerOption } from './NodeValuePicker';

interface FieldOptionPickerProps {
  field: NodeProjection;
  valueNode?: NodeProjection;
  byId: Map<NodeId, NodeProjection>;
  placeholder: string;
  onSelectOption: (optionId: NodeId) => Promise<unknown> | unknown;
  onCreateOption: (name: string) => Promise<unknown> | unknown;
  onClearValue: () => Promise<unknown> | unknown;
}

export function FieldOptionPicker({
  byId,
  field,
  onClearValue,
  onCreateOption,
  onSelectOption,
  placeholder,
  valueNode,
}: FieldOptionPickerProps) {
  const options = resolveFieldOptions(field, byId);
  const selectedOptionId = resolveSelectedOptionId(valueNode, options);
  const valueTargetId = valueNode?.type === 'reference' ? valueNode.targetId : undefined;
  const selectedFallback = valueTargetId
    ? byId.get(valueTargetId)?.content.text
    : valueNode?.content.text;
  const selectedMarker = valueNode?.type === 'reference' ? 'reference' : 'bullet';
  const fieldConfig = projectFieldConfig(byId, field);
  // Options fields always accept free-typed values. `autocollectOptions` only
  // governs whether the typed value joins the reusable option pool (handled by
  // the parent's onCreateOption) — not whether typing is allowed at all.
  const canCreate = fieldConfig.fieldType === 'options';
  const pickerOptions: NodeValuePickerOption[] = options.map((option) => ({
    id: option.id,
    label: option.label,
  }));

  return (
    <NodeValuePicker
      allowClear={Boolean(valueNode)}
      allowCreate={canCreate}
      ariaLabel="Field options"
      onClear={onClearValue}
      onCreate={onCreateOption}
      onSelect={onSelectOption}
      options={pickerOptions}
      placeholder={placeholder}
      selectedFallbackLabel={selectedFallback}
      selectedId={selectedOptionId}
      selectedMarkerWhenPresent={selectedMarker}
    />
  );
}
