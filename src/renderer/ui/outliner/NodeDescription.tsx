import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { NodeDescriptionEditor } from './NodeDescriptionSurface';

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
  onReturnToSource?: () => void;
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
  onReturnToSource,
  onFocusRequestConsumed,
  onPendingInputConsumed,
}: NodeDescriptionProps) {
  const [draft, setDraft] = useState(node.description ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const skipCommitRef = useRef(false);
  const blurCommitTimerRef = useRef<number | null>(null);
  const shouldRender = editing || Boolean(node.description);

  useEffect(() => () => {
    if (blurCommitTimerRef.current !== null) {
      window.clearTimeout(blurCommitTimerRef.current);
    }
  }, []);

  useEffect(() => {
    setDraft(node.description ?? '');
  }, [node.id, node.description]);

  useEffect(() => {
    if (editing) skipCommitRef.current = false;
  }, [editing]);

  useLayoutEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, editing]);

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

  const persistDraft = (value = inputRef.current?.value ?? draft) => {
    const next = value.trim();
    if (next === (node.description ?? '')) return Promise.resolve(null);
    return run(() => api.updateNodeDescription(targetId, next || null));
  };

  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (blurCommitTimerRef.current !== null) window.clearTimeout(blurCommitTimerRef.current);
    blurCommitTimerRef.current = window.setTimeout(() => {
      blurCommitTimerRef.current = null;
      void persistDraft().then(() => {
        onEditingChange(false);
      });
    }, 0);
  };

  return (
    <NodeDescriptionEditor
      inputRef={inputRef}
      focusId={`${targetId}:description`}
      value={draft}
      onValueChange={setDraft}
      onCommit={commit}
      onFocus={() => {
        if (focusTarget) onFocusTarget?.(focusTarget);
        onEditingChange(true);
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
        if (
          event.ctrlKey
          && !event.metaKey
          && !event.altKey
          && !event.shiftKey
          && (event.key.toLowerCase() === 'i' || event.code === 'KeyI' || event.key === 'Tab')
        ) {
          event.preventDefault();
          skipCommitRef.current = true;
          void persistDraft().then(() => {
            if (onReturnToSource) onReturnToSource();
            else onEditingChange(false);
          });
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
