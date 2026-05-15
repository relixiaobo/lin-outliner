import { useCallback } from 'react';
import type {
  CommandOutcome,
  DocumentProjection,
  FieldType,
  FocusHint,
  NodeId,
  NodeProjection,
} from '../api/types';
import { focusEditor, type EditorFocusPlacement } from './editor/editorRegistry';

export type CommandRunner = (
  operation: () => Promise<CommandOutcome | DocumentProjection>,
) => Promise<CommandOutcome | DocumentProjection | null>;

export interface TriggerAnchor {
  left: number;
  top: number;
  bottom: number;
}

export interface EditorTrigger {
  kind: '#' | '@' | '/';
  query: string;
  from: number;
  to: number;
  anchor?: TriggerAnchor;
}

export type TriggerState =
  | ({ nodeId: NodeId } & EditorTrigger)
  | null;

export const FIELD_TYPE_OPTIONS: FieldType[] = [
  'plain',
  'date',
  'number',
  'url',
  'email',
  'checkbox',
  'boolean',
  'options',
  'options_from_supertag',
  'color',
];

export function isContentNode(node: NodeProjection | undefined): boolean {
  return Boolean(node && (!node.type || node.type === 'codeBlock'));
}

export function textOf(node: NodeProjection | undefined): string {
  if (!node) return '';
  if (node.type === 'reference' && node.targetId) return `@${node.targetId}`;
  return node.content.text || 'Untitled';
}

export function outlinerChildren(
  node: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  if (!node) return [];
  return node.children.filter((childId) => {
    const child = byId.get(childId);
    return Boolean(child) && child?.type !== 'queryCondition';
  });
}

export function fieldEntries(
  node: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): NodeProjection[] {
  if (!node) return [];
  return node.children
    .map((childId) => byId.get(childId))
    .filter((child): child is NodeProjection => child?.type === 'fieldEntry');
}

export function focusRowInput(nodeId: NodeId, placement: EditorFocusPlacement = 'end') {
  window.requestAnimationFrame(() => {
    focusEditor(nodeId, placement);
    const focusTargets = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '[data-focus-node-id]',
    );
    for (const target of focusTargets) {
      if (target.dataset.focusNodeId !== nodeId) continue;
      target.focus();
      if (placement === 'all') {
        target.select();
      } else {
        const cursor = typeof placement === 'object'
          ? Math.max(0, Math.min(target.value.length, placement.offset))
          : placement === 'start'
            ? 0
            : target.value.length;
        target.setSelectionRange(cursor, cursor);
      }
      break;
    }
  });
}

export function focusTrailingInput(parentId: NodeId): boolean {
  const rows = document.querySelectorAll<HTMLElement>('[data-trailing-parent-id]');
  for (const row of rows) {
    if (row.dataset.trailingParentId !== parentId) continue;
    const editor = row.querySelector<HTMLElement>('.ProseMirror');
    if (!editor) continue;
    editor.focus({ preventScroll: true });
    return true;
  }
  return false;
}

export function useCommandRunner(
  setProjection: (projection: DocumentProjection) => void,
  setFocus: (focus: FocusHint | null) => void,
  setError: (message: string | null) => void,
): CommandRunner {
  return useCallback(async (operation) => {
    try {
      const result = await operation();
      if ('projection' in result) {
        setProjection(result.projection);
        setFocus(result.focus ?? null);
      } else {
        setProjection(result);
        setFocus(null);
      }
      setError(null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [setError, setFocus, setProjection]);
}
