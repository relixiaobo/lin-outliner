import type { NodeProjection, ViewMode } from '../../../core/types';
import {
  findViewDef,
  isRenderableViewMode,
  RENDERABLE_VIEW_MODES,
} from '../../../core/viewConfig';
import type { OutlineDocument } from './agentOutlineParser';
import type { NodeToolIssue } from './agentNodeToolTypes';

const CORE_VIEW_MODES = {
  list: true,
  table: true,
  cards: true,
  calendar: true,
} as const satisfies Record<ViewMode, true>;

export function viewModeOf(
  nodes: ReadonlyMap<string, NodeProjection>,
  owner: NodeProjection,
): ViewMode {
  const viewDef = findViewDef(nodes, owner);
  return viewDef?.type === 'viewDef' ? viewDef.viewMode ?? 'list' : 'list';
}

export function validateViewModes(
  document: OutlineDocument,
  options: { existingRootMode?: ViewMode } = {},
): NodeToolIssue | null {
  const root = document.roots[0];
  const stack = [...document.roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.view && !isRenderableViewMode(node.view)) {
      const preservesExistingRootMode = node === root && node.view === options.existingRootMode;
      if (!preservesExistingRootMode) {
        const allowed = RENDERABLE_VIEW_MODES.join(', ');
        if (Object.prototype.hasOwnProperty.call(CORE_VIEW_MODES, node.view)) {
          return {
            code: 'view_mode_not_available',
            error: `View mode "${node.view}" is not available in this app. Available view modes: ${allowed}.`,
            instructions: 'Use %%view:list%% or %%view:table%% on the owner node.',
          };
        }
        return {
          code: 'invalid_view_mode',
          error: `Invalid view mode "${node.view}". Allowed view modes: ${allowed}.`,
          instructions: 'Use %%view:list%% or %%view:table%% on the owner node.',
        };
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }
  return null;
}
