import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import type { FocusRequest, FocusTarget, PendingInputChar } from '../../state/document';
import { focusTargetMatches } from '../focus/focusModel';
import {
  insertTextIntoControlValue,
  setTextControlCursor,
} from '../focus/textControlFocus';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import type { CommandRunner } from '../shared';
import { NodeDescriptionEditor, NodeDescriptionRead } from './NodeDescriptionSurface';

interface NodeDescriptionProps {
  node: NodeProjection;
  targetId: NodeId;
  editing: boolean;
  run: CommandRunner;
  onEditingChange: (editing: boolean) => void;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  pendingInput?: PendingInputChar | null;
  onFocusTarget?: (target: FocusTarget) => void;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onPendingInputConsumed?: (input: PendingInputChar) => void;
}

export function NodeDescription({
  node,
  targetId,
  editing,
  run,
  onEditingChange,
  focusTarget,
  focusRequest,
  pendingInput,
  onFocusTarget,
  onFocusRequestConsumed,
  onPendingInputConsumed,
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
    if (focusTarget && focusRequest && focusTargetMatches(focusRequest.target, focusTarget)) return;
    if (focusTarget && pendingInput && focusTargetMatches(pendingInput.target, focusTarget)) return;
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      setTextControlCursor(input, { kind: 'end' });
    });
  }, [editing, focusRequest, focusTarget, pendingInput]);

  useEffect(() => {
    if (!focusTarget || !focusRequest || !focusTargetMatches(focusRequest.target, focusTarget)) return;
    onEditingChange(true);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      setTextControlCursor(input, focusRequest.placement);
      onFocusRequestConsumed?.(focusRequest);
    });
  }, [focusRequest, focusTarget, onEditingChange, onFocusRequestConsumed]);

  useEffect(() => {
    if (!focusTarget || !pendingInput || !focusTargetMatches(pendingInput.target, focusTarget)) return;
    onEditingChange(true);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const next = insertTextIntoControlValue({
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        text: pendingInput.char,
      });
      setDraft(next.value);
      window.requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(next.cursor, next.cursor);
      });
      onPendingInputConsumed?.(pendingInput);
    });
  }, [focusTarget, onEditingChange, onPendingInputConsumed, pendingInput]);

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
        onEdit={() => {
          if (focusTarget) onFocusTarget?.(focusTarget);
          onEditingChange(true);
        }}
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
      onFocus={() => {
        if (focusTarget) onFocusTarget?.(focusTarget);
      }}
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
