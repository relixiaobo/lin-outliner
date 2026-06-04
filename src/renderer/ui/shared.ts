import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import type {
  CommandResult,
  ProjectionSnapshot,
  ProjectionUpdate,
  FocusHint,
  NodeId,
  NodeProjection,
} from '../api/types';
import { isInternalConfigNode } from '../../core/configSchema';
import { FIELD_TYPE_CONFIG_OPTIONS } from './fields/fieldTypeRegistry';
import { measureRender } from './outliner/renderProbe';

export interface CommandRunnerOptions {
  applyFocus?: boolean;
  applyProjection?: boolean;
}

export type CommandRunner = (
  operation: () => Promise<CommandResult | ProjectionSnapshot>,
  options?: CommandRunnerOptions,
) => Promise<CommandResult | ProjectionSnapshot | null>;

export interface CommandRunnerLifecycle {
  onLocalCommandStart?: () => void;
  onLocalCommandSettled?: () => void;
}

const EMPTY_COMMAND_RUNNER_LIFECYCLE: CommandRunnerLifecycle = {};

export interface NavigateRootOptions {
  focus?: boolean;
  newPane?: boolean;
}

interface ModifierClickEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
}

export function wantsNewPaneFromClick(event: ModifierClickEventLike): boolean {
  return event.metaKey || event.ctrlKey;
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

// Raw node text for display/serialization. Defaults to '' for empty content; a
// display caller passes its localized fallback (`textOf(node, t.common.untitled)`)
// so the "untitled" copy follows the UI language. The default stays '' rather than a
// baked English 'Untitled', which silently defeated callers' localized fallbacks —
// data/serialization callers that want raw text just omit the argument.
export function textOf(node: NodeProjection | undefined, fallback = ''): string {
  if (!node) return fallback;
  if (node.type === 'reference' && node.targetId) return `@${node.targetId}`;
  return node.content.text || fallback;
}

export function outlinerChildren(
  node: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  if (!node) return [];
  return node.children.filter((childId) => {
    const child = byId.get(childId);
    if (!child || isInternalConfigNode(child)) return false;
    return !['queryCondition', 'viewDef', 'sortRule', 'filterRule', 'displayField'].includes(child.type ?? '');
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
  applyProjectionUpdate: (update: ProjectionUpdate) => void,
  setFocus: (focus: FocusHint | null) => void,
  setError: (message: string | null) => void,
  lifecycle: CommandRunnerLifecycle = EMPTY_COMMAND_RUNNER_LIFECYCLE,
): CommandRunner {
  return useCallback(async (operation, options) => {
    lifecycle.onLocalCommandStart?.();
    try {
      const result = await operation();
      if (options?.applyProjection === false) {
        setError(null);
        return result;
      }
      // A mutation returns a `CommandResult` (an `update` to fold in); a no-op /
      // query path returns a `ProjectionSnapshot` (apply as a full reseed).
      if ('update' in result) {
        measureRender(() => flushSync(() => {
          applyProjectionUpdate(result.update);
          setFocus(options?.applyFocus === false ? null : result.focus ?? null);
        }));
      } else {
        measureRender(() => flushSync(() => {
          applyProjectionUpdate({ kind: 'full', revision: result.revision, projection: result.projection });
          setFocus(null);
        }));
      }
      setError(null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      lifecycle.onLocalCommandSettled?.();
    }
  }, [lifecycle, setError, setFocus, applyProjectionUpdate]);
}
