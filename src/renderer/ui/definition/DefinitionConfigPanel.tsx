import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type {
  FieldConfigPatch,
  FieldType,
  HideFieldMode,
  NodeId,
  NodeProjection,
  TagConfigPatch,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  CheckboxIcon,
  ColorIcon,
  HashIcon,
  HideIcon,
  ICON_SIZE,
  OptionsIcon,
  ReferenceIcon,
  SettingsIcon,
  TagIcon,
} from '../icons';
import { fieldTypeLabel, FieldTypeIcon } from '../outliner/fieldTypePresentation';
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import {
  definitionConfigItems,
  FIELD_TYPE_CONFIG_OPTIONS,
  HIDE_FIELD_OPTIONS,
  type DefinitionConfigItem,
} from './definitionConfig';

interface DefinitionConfigPanelProps {
  node: NodeProjection;
  index: DocumentIndex;
  run: CommandRunner;
}

interface TagOption {
  id: NodeId;
  label: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function DefinitionConfigPanel({ node, index, run }: DefinitionConfigPanelProps) {
  const items = definitionConfigItems(node);
  const tagOptions = useMemo(
    () => index.projection.nodes
      .filter((candidate) => candidate.type === 'tagDef' && candidate.id !== node.id)
      .map((candidate) => ({ id: candidate.id, label: textOf(candidate) }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })),
    [index.projection.nodes, node.id],
  );

  const updateTag = (patch: TagConfigPatch) => {
    void run(() => api.setTagConfig(node.id, patch));
  };
  const updateField = (patch: FieldConfigPatch) => {
    void run(() => api.setFieldConfig(node.id, patch));
  };

  return (
    <section className="definition-config-panel" aria-label="Definition configuration">
      {items.map((item) => (
        <DefinitionConfigRow
          key={item.key}
          item={item}
          node={node}
          tagOptions={tagOptions}
          updateTag={updateTag}
          updateField={updateField}
        />
      ))}
    </section>
  );
}

function DefinitionConfigRow(props: {
  item: DefinitionConfigItem;
  node: NodeProjection;
  tagOptions: TagOption[];
  updateTag: (patch: TagConfigPatch) => void;
  updateField: (patch: FieldConfigPatch) => void;
}) {
  return (
    <div className="definition-config-row" data-config-key={props.item.key}>
      <span className="definition-config-icon" aria-hidden="true">
        <ConfigIcon item={props.item} node={props.node} />
      </span>
      <span className="definition-config-label">{props.item.label}</span>
      <span className="definition-config-control">
        <ConfigControl {...props} />
      </span>
    </div>
  );
}

function ConfigIcon({ item, node }: { item: DefinitionConfigItem; node: NodeProjection }) {
  if (item.key === 'fieldType') return <FieldTypeIcon fieldType={node.fieldType} size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'color') return <ColorIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'extends' || item.key === 'childSupertag' || item.key === 'sourceSupertag') {
    return <TagIcon size={ICON_SIZE.rowGlyph} />;
  }
  if (item.key === 'showCheckbox' || item.key === 'doneStateEnabled' || item.key === 'required') {
    return <CheckboxIcon size={ICON_SIZE.rowGlyph} />;
  }
  if (item.key === 'autocollectOptions') return <OptionsIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'hideField') return <HideIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'minValue' || item.key === 'maxValue') return <HashIcon size={ICON_SIZE.rowGlyph} />;
  return <SettingsIcon size={ICON_SIZE.rowGlyph} />;
}

function ConfigControl(props: {
  item: DefinitionConfigItem;
  node: NodeProjection;
  tagOptions: TagOption[];
  updateTag: (patch: TagConfigPatch) => void;
  updateField: (patch: FieldConfigPatch) => void;
}) {
  const { item, node, tagOptions, updateTag, updateField } = props;

  switch (item.key) {
    case 'color':
      return (
        <ColorControl
          label={item.label}
          value={node.color}
          swatch={resolveTagColor(node).text}
          onCommit={(color) => updateTag({ color })}
        />
      );
    case 'extends':
      return (
        <TagSelect
          label={item.label}
          value={node.extends}
          options={tagOptions}
          onChange={(tagId) => updateTag({ extends: tagId })}
        />
      );
    case 'childSupertag':
      return (
        <TagSelect
          label={item.label}
          value={node.childSupertag}
          options={tagOptions}
          onChange={(tagId) => updateTag({ childSupertag: tagId })}
        />
      );
    case 'showCheckbox':
      return (
        <SwitchControl
          label={item.label}
          checked={node.showCheckbox}
          onChange={(showCheckbox) => updateTag({ showCheckbox })}
        />
      );
    case 'doneStateEnabled':
      return (
        <SwitchControl
          label={item.label}
          checked={node.doneStateEnabled}
          onChange={(doneStateEnabled) => updateTag({ doneStateEnabled })}
        />
      );
    case 'fieldType':
      return (
        <FieldTypeSelect
          label={item.label}
          value={node.fieldType ?? 'plain'}
          onChange={(fieldType) => updateField({ fieldType })}
        />
      );
    case 'sourceSupertag':
      return (
        <TagSelect
          label={item.label}
          value={node.sourceSupertag}
          options={tagOptions}
          onChange={(sourceSupertag) => updateField({ sourceSupertag })}
        />
      );
    case 'autocollectOptions':
      return (
        <SwitchControl
          label={item.label}
          checked={node.autocollectOptions}
          onChange={(autocollectOptions) => updateField({ autocollectOptions })}
        />
      );
    case 'required':
      return (
        <SwitchControl
          label={item.label}
          checked={node.nullable === false}
          onChange={(required) => updateField({ nullable: required ? false : true })}
        />
      );
    case 'hideField':
      return (
        <HideFieldSelect
          label={item.label}
          value={(node.hideField as HideFieldMode | undefined) ?? 'never'}
          onChange={(hideField) => updateField({ hideField: hideField === 'never' ? null : hideField })}
        />
      );
    case 'minValue':
      return (
        <NumberControl
          label={item.label}
          value={node.minValue}
          onCommit={(minValue) => updateField({ minValue })}
        />
      );
    case 'maxValue':
      return (
        <NumberControl
          label={item.label}
          value={node.maxValue}
          onCommit={(maxValue) => updateField({ maxValue })}
        />
      );
    default:
      return null;
  }
}

function FieldTypeSelect(props: {
  label: string;
  value: FieldType;
  onChange: (fieldType: FieldType) => void;
}) {
  return (
    <select
      className="definition-select"
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as FieldType)}
    >
      {FIELD_TYPE_CONFIG_OPTIONS.map((fieldType) => (
        <option key={fieldType} value={fieldType}>{fieldTypeLabel(fieldType)}</option>
      ))}
    </select>
  );
}

function HideFieldSelect(props: {
  label: string;
  value: HideFieldMode;
  onChange: (mode: HideFieldMode) => void;
}) {
  return (
    <select
      className="definition-select"
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as HideFieldMode)}
    >
      {HIDE_FIELD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function TagSelect(props: {
  label: string;
  value?: NodeId;
  options: TagOption[];
  onChange: (tagId: NodeId | null) => void;
}) {
  return (
    <span className="definition-select-wrap">
      <ReferenceIcon size={ICON_SIZE.rowGlyph} aria-hidden="true" />
      <select
        className="definition-select"
        aria-label={props.label}
        value={props.value ?? ''}
        onChange={(event) => props.onChange(event.target.value || null)}
      >
        <option value="">None</option>
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </span>
  );
}

function SwitchControl(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`definition-switch ${props.checked ? 'on' : ''}`}
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="definition-switch-track">
        <span className="definition-switch-thumb" />
      </span>
      <span>{props.checked ? 'Yes' : 'No'}</span>
    </button>
  );
}

function ColorControl(props: {
  label: string;
  value?: string;
  swatch: string;
  onCommit: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(props.value ?? '');

  useEffect(() => {
    setDraft(props.value ?? '');
  }, [props.value]);

  const commit = (value: string) => {
    const normalized = value.trim();
    props.onCommit(normalized ? normalized : null);
  };
  const swatchValue = HEX_COLOR.test(draft) ? draft : props.swatch;

  return (
    <span className="definition-color-control">
      <input
        type="color"
        aria-label={`${props.label} swatch`}
        value={swatchValue}
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
      />
      <input
        className="definition-text-input"
        aria-label={props.label}
        value={draft}
        placeholder="auto"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setDraft(props.value ?? '');
            event.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}

function NumberControl(props: {
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
    <input
      className="definition-text-input"
      type="number"
      aria-label={props.label}
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
