import { api } from '../../api/client';
import type { NodeProjection } from '../../api/types';
import { plainText } from '../../api/types';
import { CheckboxMark } from '../primitives/CheckboxMark';
import type { CommandRunner } from '../shared';
import { useT } from '../../i18n/I18nProvider';

interface CheckboxFieldControlProps {
  entryId: string;
  run: CommandRunner;
  valueNode?: NodeProjection;
}

// The lone whole-field value control: a boolean toggle stored as a plain node
// ('true' / 'false'). Every other field type edits as a node row; a boolean has
// no editable text, so it stays a single control. The value is still a node, so
// the toggle creates or replaces it through the generic node commands.
export function CheckboxFieldControl({ entryId, run, valueNode }: CheckboxFieldControlProps) {
  const t = useT();
  const checked = booleanValue(valueNode?.content.text ?? '');

  const toggle = () => {
    const next = checked ? 'false' : 'true';
    if (valueNode) {
      void run(() => api.replaceNodeText(valueNode.id, plainText(next)));
      return;
    }
    void run(() => api.createNode(entryId, null, next));
  };

  return (
    <button
      type="button"
      className={`typed-field-boolean typed-field-checkbox ${checked ? 'checked' : ''}`}
      role="checkbox"
      aria-checked={checked}
      onClick={toggle}
    >
      <CheckboxMark checked={checked} />
      <span>{checked ? t.outliner.field.booleanYes : t.outliner.field.booleanNo}</span>
    </button>
  );
}

function booleanValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}
