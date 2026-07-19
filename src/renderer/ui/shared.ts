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
  // Run local renderer state updates in the same synchronous commit as the
  // projection update, so structural commands do not expose an intermediate DOM.
  beforeApply?: () => void;
}

export interface CommandRunnerNoop {
  kind: 'noop';
}

export interface CommandRunnerAbort {
  kind: 'abort';
}

export type CommandRunnerResult = CommandResult | ProjectionSnapshot | CommandRunnerNoop;
export type CommandRunnerOperationResult = CommandRunnerResult | CommandRunnerAbort | null | void;

type CommandRunnerNoopResult = CommandRunnerNoop | null | undefined;
type ResolvedCommandRunnerOperationResult = CommandRunnerResult | CommandRunnerAbort | null | undefined;

const COMMAND_RUNNER_NOOP: CommandRunnerNoop = { kind: 'noop' };
const COMMAND_RUNNER_ABORT: CommandRunnerAbort = { kind: 'abort' };

export function commandRunnerNoop(): CommandRunnerNoop {
  return COMMAND_RUNNER_NOOP;
}

export function commandRunnerAbort(): CommandRunnerAbort {
  return COMMAND_RUNNER_ABORT;
}

function isCommandRunnerNoopResult(result: ResolvedCommandRunnerOperationResult): result is CommandRunnerNoopResult {
  return result == null || ('kind' in result && result.kind === 'noop');
}

function isCommandRunnerAbortResult(result: ResolvedCommandRunnerOperationResult): result is CommandRunnerAbort {
  return Boolean(result && 'kind' in result && result.kind === 'abort');
}

export type CommandRunner = (
  operation: () => Promise<CommandRunnerOperationResult>,
  options?: CommandRunnerOptions,
) => Promise<CommandRunnerResult | null>;

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

export function parentIdsEmptiedByOutdent(
  nodeIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
  rootId?: NodeId | null,
): Set<NodeId> {
  const movedIds = new Set(nodeIds);
  const candidateParentIds = new Set<NodeId>();
  for (const nodeId of nodeIds) {
    const parentId = byId.get(nodeId)?.parentId;
    if (!parentId || parentId === rootId) continue;
    const parent = byId.get(parentId);
    if (!parent?.parentId) continue;
    candidateParentIds.add(parentId);
  }

  const emptiedParentIds = new Set<NodeId>();
  for (const parentId of candidateParentIds) {
    const children = outlinerChildren(byId.get(parentId), byId);
    if (children.length > 0 && children.every((childId) => movedIds.has(childId))) {
      emptiedParentIds.add(parentId);
    }
  }
  return emptiedParentIds;
}

export function collapseExpandedParentIds(
  expanded: ReadonlySet<NodeId>,
  parentIds: ReadonlySet<NodeId>,
): Set<NodeId> {
  const next = new Set(expanded);
  for (const parentId of parentIds) {
    next.delete(parentId);
  }
  return next;
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
): CommandRunner {
  return useCallback(async (operation, options) => {
    try {
      const result = (await operation()) as ResolvedCommandRunnerOperationResult;
      // Abort means a nested runner already handled a failed command and left the
      // user-visible error state in place. Do not treat it as a clean no-op.
      if (isCommandRunnerAbortResult(result)) return null;
      // A no-op is renderer-local: nothing crossed the command boundary, so there
      // is no projection, focus, or local pre-apply work to commit.
      if (isCommandRunnerNoopResult(result)) {
        setError(null);
        return result ?? COMMAND_RUNNER_NOOP;
      }
      // A mutation returns a `CommandResult` (an `update` to fold in); an explicit
      // refresh returns a `ProjectionSnapshot` (apply as a full reseed).
      if ('update' in result) {
        measureRender(() => flushSync(() => {
          options?.beforeApply?.();
          applyProjectionUpdate(result.update);
          setFocus(options?.applyFocus === false ? null : result.focus ?? null);
        }));
      } else {
        measureRender(() => flushSync(() => {
          options?.beforeApply?.();
          applyProjectionUpdate({ kind: 'full', revision: result.revision, projection: result.projection });
          setFocus(null);
        }));
      }
      setError(null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [setError, setFocus, applyProjectionUpdate]);
}
