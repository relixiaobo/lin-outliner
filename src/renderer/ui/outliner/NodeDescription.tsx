import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import type { CommandRunner } from '../shared';
import { NodeDescriptionEditor, NodeDescriptionRead } from './NodeDescriptionSurface';

interface NodeDescriptionProps {
  node: NodeProjection;
  targetId: NodeId;
  editing: boolean;
  run: CommandRunner;
  onEditingChange: (editing: boolean) => void;
}

export function NodeDescription({
  node,
  targetId,
  editing,
  run,
  onEditingChange,
}: NodeDescriptionProps) {
  const [draft, setDraft] = useState(node.description ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const skipCommitRef = useRef(false);
  const shouldRender = editing || Boolean(node.description);

  useEffect(() => {
    setDraft(node.description ?? '');
  }, [node.id, node.description]);

  useEffect(() => {
    if (!editing) return;
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    });
  }, [editing]);

  if (!shouldRender) return null;

  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    const next = draft.trim();
    onEditingChange(false);
    if (next === (node.description ?? '')) return;
    void run(() => api.updateNodeDescription(targetId, next || null));
  };

  if (!editing) {
    return (
      <NodeDescriptionRead
        description={node.description ?? ''}
        onEdit={() => onEditingChange(true)}
      />
    );
  }

  return (
    <NodeDescriptionEditor
      inputRef={inputRef}
      focusId={`${targetId}:description`}
      value={draft}
      onValueChange={setDraft}
      onCommit={commit}
      onKeyDown={(event) => {
        if (isImeComposingEvent(event)) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          skipCommitRef.current = true;
          setDraft(node.description ?? '');
          onEditingChange(false);
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
