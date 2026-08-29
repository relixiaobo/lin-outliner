import { parentIdsEmptiedByOutdent as coreParentIdsEmptiedByOutdent } from '../../core/actions/outlineStructure';
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
import { FIELD_TYPE_CONFIG_OPTIONS } from './fields/fieldTypeRegistry';
import { measureRender } from './outliner/renderProbe';

export interface CommandRunnerOptions {
  applyFocus?: boolean;
  // Run local renderer state updates in the same synchronous commit as the
  // projection update, so structural commands do not expose an intermediate DOM.
  beforeApply?: (result: CommandResult | ProjectionSnapshot) => void;
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

export { outlineChildIds as outlinerChildren } from '../../core/actions/outlineStructure';

/** The shipped `Set` shape over the core derivation. */
export function parentIdsEmptiedByOutdent(
  nodeIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
  rootId?: NodeId | null,
): Set<NodeId> {
  return new Set(coreParentIdsEmptiedByOutdent(nodeIds, byId, rootId));
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
        return result ?? COMMAND_RUNNER_NOOP;
      }
      // A mutation returns a `CommandResult` (an `update` to fold in); an explicit
      // refresh returns a `ProjectionSnapshot` (apply as a full reseed).
      if ('update' in result) {
        measureRender(() => flushSync(() => {
          options?.beforeApply?.(result);
          applyProjectionUpdate(result.update);
          setFocus(options?.applyFocus === false ? null : result.focus ?? null);
        }));
      } else {
        measureRender(() => flushSync(() => {
          options?.beforeApply?.(result);
          applyProjectionUpdate({ kind: 'full', revision: result.revision, projection: result.projection });
          setFocus(null);
        }));
      }
      // No clear on success. `setError` writes the app-wide notice, which any
      // surface may have raised, so clearing here would delete a failure this
      // command has nothing to do with — and it fires on every keystroke that
      // runs a command, which would erase a report the user is still reading.
      // The notice expires on its own.
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [setError, setFocus, applyProjectionUpdate]);
}
