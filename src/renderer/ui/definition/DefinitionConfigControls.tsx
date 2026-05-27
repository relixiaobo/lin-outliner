import { useEffect, useState } from 'react';
import type { AutoInitStrategy, FieldCardinality, FieldType, HideFieldMode, NodeId, NodeProjection } from '../../api/types';
import { projectTagConfig } from '../../../core/configProjection';
import { resolveFieldOptions } from '../interactions/fieldOptions';
import { fieldTypeLabel } from '../outliner/fieldTypePresentation';
import { NodeValuePicker, type NodeValuePickerMarker } from '../outliner/NodeValuePicker';
import { NumberInputControl } from '../primitives/NumberInputControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { TAG_COLOR_PRESETS } from '../tags/tagColors';
import {
  FIELD_TYPE_CONFIG_OPTIONS,
  FIELD_CARDINALITY_OPTIONS,
  HIDE_FIELD_OPTIONS,
} from './definitionConfig';

export interface TagOption {
  color?: string;
  id: NodeId;
  label: string;
}

interface ChoiceOption<T extends string> {
  color?: string;
  marker?: NodeValuePickerMarker;
  value: T;
  label: string;
}

const AUTO_INIT_LABELS: Record<AutoInitStrategy, string> = {
  current_date: 'Current date',
  ancestor_day_node: 'Ancestor day node',
  ancestor_field_value: 'Ancestor field value',
  ancestor_supertag_ref: 'Ancestor with source supertag',
};

const AUTO_INIT_BY_FIELD_TYPE: Partial<Record<FieldType, AutoInitStrategy[]>> = {
  date: ['current_date', 'ancestor_day_node', 'ancestor_field_value'],
  options_from_supertag: ['ancestor_supertag_ref'],
};

function autoInitStrategiesForField(fieldType: FieldType | undefined): AutoInitStrategy[] {
  return AUTO_INIT_BY_FIELD_TYPE[fieldType ?? 'plain'] ?? ['ancestor_field_value'];
}

function parseAutoInitStrategies(value: string | undefined): AutoInitStrategy[] {
  const allowed = new Set<AutoInitStrategy>([
    'current_date',
    'ancestor_day_node',
    'ancestor_field_value',
    'ancestor_supertag_ref',
  ]);
  return (value ?? '')
    .split(',')
    .map((strategy) => strategy.trim())
    .filter((strategy): strategy is AutoInitStrategy => allowed.has(strategy as AutoInitStrategy));
}

function serializeAutoInitStrategies(strategies: AutoInitStrategy[]): string | null {
  return strategies.length > 0 ? strategies.join(',') : null;
}

export function DefinitionFieldTypeSelect(props: {
  label: string;
  value: FieldType;
  onChange: (fieldType: FieldType) => void;
}) {
  return (
    <DefinitionChoicePicker
      label={props.label}
      value={props.value}
      options={FIELD_TYPE_CONFIG_OPTIONS.map((fieldType) => ({
        value: fieldType,
        label: fieldTypeLabel(fieldType),
      }))}
      onChange={props.onChange}
    />
  );
}

export function DefinitionHideFieldSelect(props: {
  label: string;
  value: HideFieldMode;
  onChange: (mode: HideFieldMode) => void;
}) {
  return (
    <DefinitionChoicePicker
      label={props.label}
      value={props.value}
      options={HIDE_FIELD_OPTIONS}
      onChange={props.onChange}
    />
  );
}

export function DefinitionCardinalitySelect(props: {
  label: string;
  value: FieldCardinality;
  onChange: (cardinality: FieldCardinality) => void;
}) {
  return (
    <DefinitionChoicePicker
      label={props.label}
      value={props.value}
      options={FIELD_CARDINALITY_OPTIONS}
      onChange={props.onChange}
    />
  );
}

export function DefinitionTagSelect(props: {
  label: string;
  value?: NodeId;
  options: TagOption[];
  onChange: (tagId: NodeId | null) => void;
}) {
  return (
    <NodeValuePicker
      allowClear={Boolean(props.value)}
      ariaLabel={props.label}
      onClear={() => props.onChange(null)}
      onSelect={(tagId) => props.onChange(tagId as NodeId)}
      options={props.options.map((option) => ({
        id: option.id,
        label: option.label || 'Untitled',
        marker: 'hash',
        color: option.color,
      }))}
      placeholder="None"
      selectedId={props.value}
    />
  );
}

interface TagOptionField {
  fieldDefId: NodeId;
  label: string;
  options: Array<{ id: NodeId; label: string }>;
}

/** Every options field carried by a tag (own + inherited via extends), with its options. */
function tagOptionFields(byId: Map<NodeId, NodeProjection>, tagDefId: NodeId): TagOptionField[] {
  const fields: TagOptionField[] = [];
  const seenFields = new Set<NodeId>();
  const visitedTags = new Set<NodeId>();
  let current: NodeId | undefined = tagDefId;
  while (current && !visitedTags.has(current)) {
    visitedTags.add(current);
    const tag = byId.get(current);
    if (!tag) break;
    for (const childId of tag.children) {
      const child = byId.get(childId);
      const fieldDefId = child?.type === 'fieldEntry' ? child.fieldDefId : undefined;
      if (!fieldDefId || seenFields.has(fieldDefId)) continue;
      const fieldDef = byId.get(fieldDefId);
      if (fieldDef?.type !== 'fieldDef') continue;
      const options = resolveFieldOptions(fieldDef, byId);
      if (options.length === 0) continue;
      seenFields.add(fieldDefId);
      fields.push({
        fieldDefId,
        label: fieldDef.content.text || 'Field',
        options: options.map((option) => ({ id: option.id, label: option.label })),
      });
    }
    current = projectTagConfig(byId, tag).extends;
  }
  return fields;
}

export function DefinitionDoneMappingControl(props: {
  label: string;
  byId: Map<NodeId, NodeProjection>;
  tagDefId: NodeId;
  value: NodeId[];
  onChange: (optionIds: NodeId[]) => void;
}) {
  const fields = tagOptionFields(props.byId, props.tagDefId);
  if (fields.length === 0) {
    return <span className="definition-done-mapping-empty">Add an options field to map its done state.</span>;
  }
  return (
    <span className="definition-done-mapping" aria-label={props.label}>
      {fields.map((field) => {
        const selected = props.value.find((id) => field.options.some((option) => option.id === id));
        const setOption = (optionId: NodeId | null) => {
          const next = props.value.filter((id) => !field.options.some((option) => option.id === id));
          if (optionId) next.push(optionId);
          props.onChange(next);
        };
        return (
          <span key={field.fieldDefId} className="definition-done-mapping-row">
            <span className="definition-done-mapping-field">{field.label}</span>
            <NodeValuePicker
              allowClear={Boolean(selected)}
              ariaLabel={`${props.label}: ${field.label}`}
              onClear={() => setOption(null)}
              onSelect={(optionId) => setOption(optionId as NodeId)}
              options={field.options.map((option) => ({ id: option.id, label: option.label || 'Untitled' }))}
              placeholder="None"
              selectedId={selected}
            />
          </span>
        );
      })}
    </span>
  );
}

function DefinitionChoicePicker<T extends string>(props: {
  label: string;
  value: T;
  options: Array<ChoiceOption<T>>;
  onChange: (value: T) => void;
}) {
  return (
    <NodeValuePicker
      ariaLabel={props.label}
      onSelect={(value) => props.onChange(value as T)}
      options={props.options.map((option) => ({
        id: option.value,
        label: option.label,
        marker: option.marker,
        color: option.color,
      }))}
      placeholder="None"
      selectedId={props.value}
    />
  );
}

export function DefinitionAutoInitializeControl(props: {
  fieldType?: FieldType;
  label: string;
  value?: string;
  onChange: (value: string | null) => void;
}) {
  const enabled = parseAutoInitStrategies(props.value);
  const enabledSet = new Set(enabled);
  const strategies = autoInitStrategiesForField(props.fieldType);

  return (
    <span className="definition-auto-init-group" aria-label={props.label}>
      {strategies.map((strategy) => {
        const checked = enabledSet.has(strategy);
        return (
          <DefinitionSwitchControl
            key={strategy}
            label={AUTO_INIT_LABELS[strategy]}
            checked={checked}
            onChange={(nextChecked) => {
              const next = new Set(enabled);
              if (nextChecked) next.add(strategy);
              else next.delete(strategy);
              props.onChange(serializeAutoInitStrategies(strategies.filter((candidate) => next.has(candidate))));
            }}
          />
        );
      })}
    </span>
  );
}

export function DefinitionSwitchControl(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SwitchControl
      className={`definition-switch ${props.checked ? 'on' : ''}`}
      checked={props.checked}
      label={props.label}
      onCheckedChange={props.onChange}
    >
      <SwitchMark checked={props.checked} />
      <span>{props.checked ? 'Yes' : 'No'}</span>
    </SwitchControl>
  );
}

export function DefinitionColorControl(props: {
  label: string;
  value?: string;
  onCommit: (value: string | null) => void;
}) {
  const selected = props.value ?? null;
  return (
    <span className="definition-color-control" role="radiogroup" aria-label={props.label}>
      <button
        type="button"
        className={`definition-color-swatch definition-color-swatch-none ${selected ? '' : 'selected'}`}
        role="radio"
        aria-checked={!selected}
        aria-label="No color"
        title="No color"
        onClick={() => props.onCommit(null)}
      />
      {TAG_COLOR_PRESETS.map((preset) => {
        const isSelected = selected === preset.token;
        return (
          <button
            key={preset.token}
            type="button"
            className={`definition-color-swatch ${isSelected ? 'selected' : ''}`}
            role="radio"
            aria-checked={isSelected}
            aria-label={preset.label}
            title={preset.label}
            style={{ background: preset.color.text }}
            onClick={() => props.onCommit(preset.token)}
          />
        );
      })}
    </span>
  );
}

export function DefinitionNumberControl(props: {
  label: string;
  value?: number;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(props.value == null ? '' : String(props.value));

  useEffect(() => {
    setDraft(props.value == null ? '' : String(props.value));
  }, [props.value]);

  const commit = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      props.onCommit(null);
      return;
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      props.onCommit(parsed);
    } else {
      setDraft(props.value == null ? '' : String(props.value));
    }
  };

  return (
    <NumberInputControl
      className="definition-text-input"
      label={props.label}
      value={draft}
      placeholder="None"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraft(props.value == null ? '' : String(props.value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}
