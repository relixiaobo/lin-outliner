import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import type {
  CommandOutcome,
  DocumentProjection,
  FocusHint,
  NodeId,
  NodeProjection,
} from '../api/types';
import { FIELD_TYPE_CONFIG_OPTIONS } from './fields/fieldTypeRegistry';

export type CommandRunner = (
  operation: () => Promise<CommandOutcome | DocumentProjection>,
) => Promise<CommandOutcome | DocumentProjection | null>;

export interface NavigateRootOptions {
  focus?: boolean;
}

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

export const FIELD_TYPE_OPTIONS = FIELD_TYPE_CONFIG_OPTIONS;

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

export function useCommandRunner(
  setProjection: (projection: DocumentProjection) => void,
  setFocus: (focus: FocusHint | null) => void,
  setError: (message: string | null) => void,
): CommandRunner {
  return useCallback(async (operation) => {
    try {
      const result = await operation();
      if ('projection' in result) {
        flushSync(() => {
          setProjection(result.projection);
          setFocus(result.focus ?? null);
        });
      } else {
        flushSync(() => {
          setProjection(result);
          setFocus(null);
        });
      }
      setError(null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [setError, setFocus, setProjection]);
}
