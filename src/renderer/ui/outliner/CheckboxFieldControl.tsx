import { useEffect, useRef, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import type { FocusRequest, FocusTarget } from '../../state/document';
import { focusTargetMatches } from '../focus/focusModel';
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
}

// The lone whole-field value control: a boolean toggle stored as a plain node
// ('true' / 'false'). Every other field type edits as a node row; a boolean has
// no editable text, so it stays a single control. The value is still a node, so
// the toggle creates or replaces it through the generic node commands.
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
    if (event.key !== 'Tab' || !props.onTab) return;
    event.preventDefault();
    props.onTab(event.shiftKey);
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
