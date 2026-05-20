import { useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { FieldType, NodeProjection } from '../../api/types';
import { normalizeDateFieldValue, plainText } from '../../api/types';
import { CheckIcon } from '../icons';
import type { CommandRunner } from '../shared';
import { DateFieldControl } from './DateFieldControl';

interface TypedFieldValueControlProps {
  entryId: string;
  fieldType: FieldType;
  placeholder: string;
  run: CommandRunner;
  valueNode?: NodeProjection;
}

export function TypedFieldValueControl({
  entryId,
  fieldType,
  placeholder,
  run,
  valueNode,
}: TypedFieldValueControlProps) {
  const value = valueNode?.content.text ?? '';
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value, valueNode?.id]);

  const commit = (nextValue: string) => {
    const normalized = normalizeValue(fieldType, nextValue);
    if (!normalized) {
      void run(() => api.clearFieldValue(entryId));
      return;
    }
    if (valueNode) {
      void run(() => api.replaceNodeText(valueNode.id, plainText(normalized)));
      return;
    }
    void run(() => api.createNode(entryId, null, normalized));
  };

  if (fieldType === 'checkbox' || fieldType === 'boolean') {
    const checked = booleanValue(value);
    return (
      <button
        type="button"
        className={`typed-field-boolean ${checked ? 'checked' : ''}`}
        role="switch"
        aria-checked={checked}
        onClick={() => commit(checked ? 'false' : 'true')}
      >
        <span className="typed-field-boolean-box">
          {checked && <CheckIcon size={12} />}
        </span>
        <span>{checked ? 'Yes' : 'No'}</span>
      </button>
    );
  }

  if (fieldType === 'date') {
    return (
      <DateFieldControl
        value={value}
        placeholder={placeholder}
        commit={commit}
      />
    );
  }

  const inputType = inputTypeForField(fieldType);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      setDraft(value);
      event.currentTarget.blur();
    }
  };

  return (
    <span className={`typed-field-control typed-field-control-${fieldType}`}>
      {fieldType === 'color' && (
        <input
          className="typed-field-color-swatch"
          type="color"
          value={hexColor(draft) ?? '#a1a1aa'}
          aria-label={`${placeholder} color`}
          onChange={(event) => {
            setDraft(event.target.value);
            commit(event.target.value);
          }}
        />
      )}
      <input
        className="typed-field-input"
        type={inputType}
        value={draft}
        placeholder={placeholder}
        spellCheck={fieldType !== 'password'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={onKeyDown}
      />
    </span>
  );
}

function inputTypeForField(fieldType: FieldType) {
  if (fieldType === 'number') return 'number';
  if (fieldType === 'url') return 'url';
  if (fieldType === 'email') return 'email';
  if (fieldType === 'password') return 'password';
  return 'text';
}

function normalizeValue(fieldType: FieldType, value: string) {
  const normalized = value.trim();
  if (fieldType === 'date') return normalizeDateFieldValue(normalized);
  if (fieldType === 'number' && normalized && !Number.isFinite(Number(normalized))) return '';
  return normalized;
}

function booleanValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function hexColor(value: string) {
  const normalized = value.trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : null;
}
