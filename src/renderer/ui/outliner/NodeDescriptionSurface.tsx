import type { KeyboardEventHandler, Ref } from 'react';
import { useT } from '../../i18n/I18nProvider';

interface NodeDescriptionEditorProps {
  inputRef: Ref<HTMLTextAreaElement>;
  focusId: string;
  value: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onFocus: () => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function NodeDescriptionEditor({
  inputRef,
  focusId,
  value,
  onValueChange,
  onCommit,
  onFocus,
  onKeyDown,
}: NodeDescriptionEditorProps) {
  const t = useT();
  return (
    <textarea
      ref={inputRef}
      className="node-description"
      data-focus-node-id={focusId}
      rows={1}
      value={value}
      placeholder={t.outliner.field.descriptionPlaceholder}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={onFocus}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      onBlur={onCommit}
      onKeyDown={onKeyDown}
    />
  );
}
