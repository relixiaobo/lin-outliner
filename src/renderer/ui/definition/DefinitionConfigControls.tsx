import { useEffect, useState } from 'react';
import type { FieldType, HideFieldMode, NodeId } from '../../api/types';
import { ICON_SIZE, ReferenceIcon } from '../icons';
import { fieldTypeLabel } from '../outliner/fieldTypePresentation';
import { NumberInputControl } from '../primitives/NumberInputControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { TextInputControl } from '../primitives/TextInputControl';
import {
  FIELD_TYPE_CONFIG_OPTIONS,
  HIDE_FIELD_OPTIONS,
} from './definitionConfig';

export interface TagOption {
  id: NodeId;
  label: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function DefinitionFieldTypeSelect(props: {
  label: string;
  value: FieldType;
  onChange: (fieldType: FieldType) => void;
}) {
  return (
    <SelectControl
      className="definition-select"
      label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as FieldType)}
    >
      {FIELD_TYPE_CONFIG_OPTIONS.map((fieldType) => (
        <option key={fieldType} value={fieldType}>{fieldTypeLabel(fieldType)}</option>
      ))}
    </SelectControl>
  );
}

export function DefinitionHideFieldSelect(props: {
  label: string;
  value: HideFieldMode;
  onChange: (mode: HideFieldMode) => void;
}) {
  return (
    <SelectControl
      className="definition-select"
      label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as HideFieldMode)}
    >
      {HIDE_FIELD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </SelectControl>
  );
}

export function DefinitionTagSelect(props: {
  label: string;
  value?: NodeId;
  options: TagOption[];
  onChange: (tagId: NodeId | null) => void;
}) {
  return (
    <span className="definition-select-wrap">
      <ReferenceIcon size={ICON_SIZE.rowGlyph} aria-hidden="true" />
      <SelectControl
        className="definition-select"
        label={props.label}
        value={props.value ?? ''}
        onChange={(event) => props.onChange(event.target.value || null)}
      >
        <option value="">None</option>
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </SelectControl>
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
      <span className="definition-switch-track">
        <span className="definition-switch-thumb" />
      </span>
      <span>{props.checked ? 'Yes' : 'No'}</span>
    </SwitchControl>
  );
}

export function DefinitionColorControl(props: {
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
      <TextInputControl
        type="color"
        label={`${props.label} swatch`}
        value={swatchValue}
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
      />
      <TextInputControl
        className="definition-text-input"
        label={props.label}
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
