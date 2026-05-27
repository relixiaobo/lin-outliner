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
  const selectedFallback = valueNode?.targetId
    ? byId.get(valueNode.targetId)?.content.text
    : valueNode?.content.text;
  const selectedMarker = valueNode?.type === 'reference' ? 'reference' : 'bullet';
  const canCreate = projectFieldConfig(byId, field).fieldType === 'options' && field.autocollectOptions !== false;
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
