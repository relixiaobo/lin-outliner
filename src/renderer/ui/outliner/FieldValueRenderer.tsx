import type {
  Dispatch,
  KeyboardEvent,
  SetStateAction,
} from 'react';
import type { FieldType, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import type { CommandRunner } from '../shared';
import { isOptionsFieldType } from '../interactions/fieldOptions';
import { FieldValueRow } from './FieldValueRow';
import { OptionsPicker } from './OptionsPicker';

interface FieldValueRendererProps {
  entryId: NodeId;
  index: DocumentIndex;
  run: CommandRunner;
  fieldType?: FieldType;
  field?: NodeProjection;
  value: string;
  valueDraft: string;
  setValueDraft: Dispatch<SetStateAction<string>>;
  onCommitValue: (nextValue?: string) => Promise<void>;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  setFocusElement?: (element: HTMLElement | null) => void;
  completed?: boolean;
}

const TRUE_VALUE = 'true';
const FALSE_VALUE = 'false';

function isTruthyValue(value: string): boolean {
  return ['true', 'yes', 'checked', '1'].includes(value.trim().toLowerCase());
}

function isValidDateValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function colorValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : '#f43f5e';
}

function numberInvalid(value: string, field?: NodeProjection): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  if (typeof field?.minValue === 'number' && parsed < field.minValue) return true;
  if (typeof field?.maxValue === 'number' && parsed > field.maxValue) return true;
  return false;
}

function textInputType(fieldType?: FieldType): string {
  switch (fieldType) {
    case 'url':
      return 'url';
    case 'email':
      return 'email';
    case 'password':
      return 'password';
    default:
      return 'text';
  }
}

function placeholderFor(fieldType?: FieldType): string {
  switch (fieldType) {
    case 'date':
      return 'Date';
    case 'number':
      return 'Number';
    case 'url':
      return 'URL';
    case 'email':
      return 'Email';
    case 'password':
      return 'Password';
    case 'options':
    case 'options_from_supertag':
      return 'Option';
    case 'color':
      return 'Color';
    default:
      return 'Value';
  }
}

export function FieldValueRenderer(props: FieldValueRendererProps) {
  const fieldType = props.fieldType ?? 'plain';

  const commitImmediateValue = (nextValue: string) => {
    props.setValueDraft(nextValue);
    void props.onCommitValue(nextValue);
  };

  if (isOptionsFieldType(fieldType)) {
    return (
      <OptionsPicker
        entryId={props.entryId}
        field={props.field}
        index={props.index}
        run={props.run}
        onFocus={props.onFocus}
        onKeyDown={props.onKeyDown}
        completed={props.completed}
        setFocusElement={props.setFocusElement}
      />
    );
  }

  if (fieldType === 'checkbox') {
    const checked = isTruthyValue(props.valueDraft);
    return (
      <FieldValueRow dimmed={!props.valueDraft} completed={props.completed}>
        <input
          ref={(element) => props.setFocusElement?.(element)}
          className="field-checkbox-input"
          type="checkbox"
          checked={checked}
          onFocus={props.onFocus}
          onChange={(event) => commitImmediateValue(event.currentTarget.checked ? TRUE_VALUE : FALSE_VALUE)}
          onKeyDown={props.onKeyDown}
        />
      </FieldValueRow>
    );
  }

  if (fieldType === 'boolean') {
    const checked = isTruthyValue(props.valueDraft);
    return (
      <FieldValueRow dimmed={!props.valueDraft} completed={props.completed}>
        <button
          ref={(element) => props.setFocusElement?.(element)}
          className={`field-boolean-switch ${checked ? 'on' : ''}`}
          type="button"
          role="switch"
          aria-checked={checked}
          onFocus={props.onFocus}
          onClick={() => commitImmediateValue(checked ? FALSE_VALUE : TRUE_VALUE)}
          onKeyDown={props.onKeyDown}
        >
          <span />
        </button>
      </FieldValueRow>
    );
  }

  if (fieldType === 'date') {
    return (
      <FieldValueRow dimmed={!props.valueDraft} completed={props.completed}>
        <input
          ref={(element) => props.setFocusElement?.(element)}
          className="field-value-input field-value-typed-input"
          type="date"
          value={isValidDateValue(props.valueDraft) ? props.valueDraft : ''}
          onFocus={props.onFocus}
          onChange={(event) => commitImmediateValue(event.currentTarget.value)}
          onKeyDown={props.onKeyDown}
        />
      </FieldValueRow>
    );
  }

  if (fieldType === 'color') {
    return (
      <FieldValueRow dimmed={!props.valueDraft} completed={props.completed}>
        <div className="field-color-value">
          <input
            ref={(element) => props.setFocusElement?.(element)}
            className="field-color-input"
            type="color"
            value={colorValue(props.valueDraft)}
            onFocus={props.onFocus}
            onChange={(event) => commitImmediateValue(event.currentTarget.value)}
            onKeyDown={props.onKeyDown}
          />
          <input
            className="field-color-text"
            value={props.valueDraft}
            placeholder="#f43f5e"
            spellCheck={false}
            onFocus={props.onFocus}
            onChange={(event) => props.setValueDraft(event.target.value)}
            onBlur={(event) => void props.onCommitValue(event.target.value)}
            onKeyDown={props.onKeyDown}
          />
        </div>
      </FieldValueRow>
    );
  }

  const invalidNumber = fieldType === 'number' && numberInvalid(props.valueDraft, props.field);

  return (
    <FieldValueRow dimmed={!props.valueDraft} completed={props.completed}>
      <input
        ref={(element) => props.setFocusElement?.(element)}
        className={`field-value-input field-value-typed-input ${invalidNumber ? 'invalid' : ''}`}
        type={textInputType(fieldType)}
        inputMode={fieldType === 'number' ? 'decimal' : undefined}
        value={props.valueDraft}
        placeholder={placeholderFor(fieldType)}
        spellCheck={fieldType === 'password' ? false : undefined}
        onFocus={props.onFocus}
        onChange={(event) => props.setValueDraft(event.target.value)}
        onBlur={(event) => void props.onCommitValue(event.target.value)}
        onKeyDown={props.onKeyDown}
      />
    </FieldValueRow>
  );
}
