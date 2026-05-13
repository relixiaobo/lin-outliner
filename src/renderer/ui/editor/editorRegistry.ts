import type { NodeId } from '../../api/types';

export type EditorFocusPlacement = 'start' | 'end' | 'all' | { offset: number };

export interface EditorHandle {
  focus: (placement?: EditorFocusPlacement) => void;
}

const handles = new Map<NodeId, EditorHandle>();

export function registerEditor(nodeId: NodeId, handle: EditorHandle): () => void {
  handles.set(nodeId, handle);
  return () => {
    if (handles.get(nodeId) === handle) {
      handles.delete(nodeId);
    }
  };
}

export function focusEditor(nodeId: NodeId, placement: EditorFocusPlacement = 'end'): boolean {
  const handle = handles.get(nodeId);
  if (handle) {
    handle.focus(placement);
    return true;
  }

  const row = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
  const input = row?.querySelector<HTMLInputElement>('input.row-input');
  if (input) {
    input.focus({ preventScroll: true });
    const offset = typeof placement === 'object'
      ? Math.max(0, Math.min(input.value.length, placement.offset))
      : placement === 'start'
        ? 0
        : input.value.length;
    if (placement === 'all') input.select();
    else input.setSelectionRange(offset, offset);
    return true;
  }

  const editor = row?.querySelector<HTMLElement>('.ProseMirror');
  if (!editor) return false;
  editor.focus({ preventScroll: true });
  return true;
}
