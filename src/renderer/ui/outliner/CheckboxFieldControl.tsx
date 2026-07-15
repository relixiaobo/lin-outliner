import { useEffect, useRef, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { FocusRequest, FocusTarget } from '../../state/document';
import { focusTargetMatches } from '../focus/focusModel';
import { resolveNodeLineKeyAction } from '../interactions/nodeLineKeymap';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxMark } from '../primitives/CheckboxMark';
import type { CommandRunner } from '../shared';
import { useT } from '../../i18n/I18nProvider';

interface CheckboxFieldControlProps {
  entryId: string;
  run: CommandRunner;
  valueNode?: NodeProjection;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  onFocus?: () => void;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onTab?: (shiftKey: boolean) => void;
  onArrowUpAtStart?: () => void;
  onArrowDownAtEnd?: () => void;
  onShiftArrow?: (direction: 'up' | 'down') => void;
  onEscape?: () => void;
}

// A boolean toggle stored as a plain node ('true' / 'false'). Before a value
// exists this is the field's empty-state control; afterward it replaces only the
// editable text surface inside a standard outliner row.
export function CheckboxFieldControl(props: CheckboxFieldControlProps) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const checked = booleanValue(props.valueNode?.content.text ?? '');

  useEffect(() => {
    const request = props.focusRequest;
    const target = props.focusTarget;
    if (!request || !target || !focusTargetMatches(request.target, target)) return;
    buttonRef.current?.focus({ preventScroll: true });
    props.onFocusRequestConsumed?.(request);
  }, [props.focusRequest, props.focusTarget, props.onFocusRequestConsumed]);

  const toggle = () => {
    const next = checked ? 'false' : 'true';
    const valueNode = props.valueNode;
    if (valueNode) {
      void props.run(() => api.replaceNodeText(valueNode.id, plainText(next)));
      return;
    }
    void props.run(() => api.createNode(props.entryId, null, next));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const structural = resolveNodeLineKeyAction(event, {
      from: 0,
      to: 0,
      textLength: 0,
      hasShiftArrow: Boolean(props.onShiftArrow),
    });
    if (!structural) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    switch (structural.type) {
      case 'indent':
        if (!props.onTab) return;
        consume();
        props.onTab(structural.shiftKey);
        return;
      case 'shiftArrow':
        if (!props.onShiftArrow) return;
        consume();
        props.onShiftArrow(structural.direction);
        return;
      case 'navigateUpAtStart':
        if (!props.onArrowUpAtStart) return;
        consume();
        props.onArrowUpAtStart();
        return;
      case 'navigateDownAtEnd':
        if (!props.onArrowDownAtEnd) return;
        consume();
        props.onArrowDownAtEnd();
        return;
      case 'escape':
        if (!props.onEscape) return;
        consume();
        props.onEscape();
        return;
      case 'split':
      case 'backspaceAtStart':
        // Enter/Space remain native checkbox activation keys. A stored boolean
        // has no text caret, so Backspace is not a text-merge gesture here.
        return;
    }
  };

  return (
    <ButtonControl
      ref={buttonRef}
      className={`typed-field-boolean typed-field-checkbox ${checked ? 'checked' : ''}`}
      role="checkbox"
      aria-checked={checked}
      onFocus={props.onFocus}
      onKeyDown={handleKeyDown}
      onClick={toggle}
    >
      <CheckboxMark checked={checked} />
      <span>{checked ? t.outliner.field.booleanYes : t.outliner.field.booleanNo}</span>
    </ButtonControl>
  );
}

function booleanValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}
