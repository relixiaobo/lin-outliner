import type { KeyboardEventHandler, Ref } from 'react';
import { ButtonControl } from '../primitives/ButtonControl';

interface NodeDescriptionReadProps {
  description: string;
  onEdit: () => void;
}

interface NodeDescriptionEditorProps {
  inputRef: Ref<HTMLTextAreaElement>;
  focusId: string;
  value: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onFocus: () => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function NodeDescriptionRead({ description, onEdit }: NodeDescriptionReadProps) {
  return (
    <ButtonControl
      className="node-description read"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onEdit}
    >
      {description}
    </ButtonControl>
  );
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
  return (
    <textarea
      ref={inputRef}
      className="node-description edit"
      data-focus-node-id={focusId}
      rows={1}
      value={value}
      placeholder="Description"
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={onFocus}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      onBlur={onCommit}
      onKeyDown={onKeyDown}
    />
  );
}
