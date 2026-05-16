import type { KeyboardEventHandler, Ref } from 'react';

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
    <button
      type="button"
      className="node-description read"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onEdit}
    >
      {description}
    </button>
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
