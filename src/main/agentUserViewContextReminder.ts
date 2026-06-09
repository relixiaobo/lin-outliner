import type {
  AgentUserViewContext,
  AgentUserViewNodeContext,
  AgentUserViewOutlineNodeContext,
  AgentUserViewPanelContext,
} from '../core/agentTypes';
import { escapeXml } from './agentReminderXml';

export function buildUserViewContextReminder(context: AgentUserViewContext | null | undefined): string | null {
  const snapshot = createSnapshot(context);
  return snapshot ? renderSnapshot(snapshot) : null;
}

export class AgentUserViewContextReminderTracker {
  private snapshots = new Map<string, UserViewSnapshot>();

  prepare(sessionId: string, context: AgentUserViewContext | null | undefined): {
    reminder: string | null;
    commit: () => void;
  } {
    const next = createSnapshot(context);
    if (!next) {
      return {
        reminder: null,
        commit: () => this.snapshots.delete(sessionId),
      };
    }
    const previous = this.snapshots.get(sessionId) ?? null;
    return {
      reminder: previous ? renderDiff(previous, next) : renderSnapshot(next),
      commit: () => this.snapshots.set(sessionId, next),
    };
  }

  reset(sessionId?: string) {
    if (sessionId) this.snapshots.delete(sessionId);
    else this.snapshots.clear();
  }
}

interface UserViewSnapshot {
  activePanelId: string | null;
  focusedPanelId: string | null;
  focusedNodeId: string | null;
  focusSurface: string | null;
  panels: PanelSnapshot[];
  referencedNodes: AgentUserViewNodeContext[];
}

interface PanelSnapshot {
  panel: AgentUserViewPanelContext;
  outlineSignature: string;
}

function createSnapshot(context: AgentUserViewContext | null | undefined): UserViewSnapshot | null {
  if (!context) return null;
  if (
    !context.activePanelId
    && !context.focusedNode
    && context.nodePanels.length === 0
    && (context.referencedNodes?.length ?? 0) === 0
  ) {
    return null;
  }
  return {
    activePanelId: context.activePanelId,
    focusedPanelId: context.focusedPanelId,
    focusedNodeId: context.focusedNode?.nodeId ?? null,
    focusSurface: context.focusSurface,
    referencedNodes: context.referencedNodes ?? [],
    panels: context.nodePanels.map((panel) => ({
      panel,
      outlineSignature: panel.visibleOutline
        .map((node) => [
          node.nodeId,
          node.title,
          node.depth,
          node.focused ? 'focused' : '',
          node.collapsed ? 'collapsed' : '',
          node.childCount ?? '',
          node.partial ? `${node.partial.included}/${node.partial.total}` : '',
        ].join('\u001f'))
        .join('\u001e'),
    })),
  };
}

function renderSnapshot(snapshot: UserViewSnapshot): string {
  const lines = ['<user-view-context mode="snapshot">'];
  lines.push(renderCurrent(snapshot));
  lines.push(...renderExplicitReferences(snapshot, 2));
  for (const panel of snapshot.panels) lines.push(...renderPanel(panel.panel, 2));
  lines.push('</user-view-context>');
  return lines.join('\n');
}

function renderDiff(previous: UserViewSnapshot, next: UserViewSnapshot): string {
  const lines = ['<user-view-context mode="diff" basis="previous-user-view-context">'];
  lines.push(renderCurrent(next));
  lines.push(...renderExplicitReferences(next, 2));
  const changes = renderChanges(previous, next);
  if (changes.length > 0) {
    lines.push('  <changes>');
    lines.push(...changes);
    lines.push('  </changes>');
  }
  lines.push('</user-view-context>');
  return lines.join('\n');
}

function renderCurrent(snapshot: UserViewSnapshot): string {
  return `  <current${xmlAttrs({
    active_panel_id: snapshot.activePanelId,
    focused_panel_id: snapshot.focusedPanelId,
    focused_node_id: snapshot.focusedNodeId,
    focus_surface: snapshot.focusSurface,
  })} />`;
}

function renderExplicitReferences(snapshot: UserViewSnapshot, spaces: number): string[] {
  if (snapshot.referencedNodes.length === 0) return [];
  const prefix = ' '.repeat(spaces);
  const lines = [`${prefix}<explicit-references>`];
  for (const node of snapshot.referencedNodes) {
    lines.push(`${prefix}  <node-ref${xmlAttrs(nodeRefAttrs(node))} />`);
  }
  lines.push(`${prefix}</explicit-references>`);
  return lines;
}

function renderChanges(previous: UserViewSnapshot, next: UserViewSnapshot): string[] {
  const lines: string[] = [];
  if (previous.activePanelId !== next.activePanelId) {
    lines.push(`    <active-panel-changed${xmlAttrs({ from: previous.activePanelId, to: next.activePanelId })} />`);
  }
  if (previous.focusedNodeId !== next.focusedNodeId) {
    lines.push(`    <focus-changed${xmlAttrs({ from_node_id: previous.focusedNodeId, to_node_id: next.focusedNodeId })} />`);
  }

  const previousPanels = new Map(previous.panels.map((panel) => [panel.panel.panelId, panel]));
  const nextPanels = new Map(next.panels.map((panel) => [panel.panel.panelId, panel]));

  for (const [panelId, panel] of previousPanels) {
    if (!nextPanels.has(panelId)) {
      lines.push(`    <panel-closed${xmlAttrs({ id: panel.panel.panelId, root_id: panel.panel.rootNodeId })} />`);
    }
  }

  for (const [panelId, panel] of nextPanels) {
    const before = previousPanels.get(panelId);
    if (!before) {
      lines.push(`    <panel-opened${xmlAttrs(panelAttrs(panel.panel))}>`);
      lines.push(...renderPanelBody(panel.panel, 6));
      lines.push('    </panel-opened>');
      continue;
    }
    if (before.panel.rootNodeId !== panel.panel.rootNodeId) {
      lines.push(`    <panel-root-changed${xmlAttrs({
        id: panel.panel.panelId,
        from_root_id: before.panel.rootNodeId,
        to_root_id: panel.panel.rootNodeId,
      })}>`);
      lines.push(...renderPanelBody(panel.panel, 6));
      lines.push('    </panel-root-changed>');
      continue;
    }
    if (before.outlineSignature !== panel.outlineSignature || before.panel.visibleOutlineTruncated !== panel.panel.visibleOutlineTruncated) {
      lines.push(`    <panel-visible-outline-changed${xmlAttrs({ id: panel.panel.panelId, root_id: panel.panel.rootNodeId })}>`);
      lines.push(...renderVisibleOutline(panel.panel, 6));
      lines.push('    </panel-visible-outline-changed>');
    }
  }

  return lines;
}

function renderPanel(panel: AgentUserViewPanelContext, spaces: number): string[] {
  return [
    `${' '.repeat(spaces)}<node-panel${xmlAttrs(panelAttrs(panel))}>`,
    ...renderPanelBody(panel, spaces + 2),
    `${' '.repeat(spaces)}</node-panel>`,
  ];
}

function renderPanelBody(panel: AgentUserViewPanelContext, spaces: number): string[] {
  return [
    ...renderBreadcrumb(panel, spaces),
    ...renderVisibleOutline(panel, spaces),
  ];
}

function renderBreadcrumb(panel: AgentUserViewPanelContext, spaces: number): string[] {
  if (panel.breadcrumb.length === 0) return [];
  const prefix = ' '.repeat(spaces);
  const lines = [`${prefix}<breadcrumb>`];
  for (const node of panel.breadcrumb) {
    lines.push(`${prefix}  <node-ref${xmlAttrs(nodeRefAttrs(node))} />`);
  }
  lines.push(`${prefix}</breadcrumb>`);
  return lines;
}

function renderVisibleOutline(panel: AgentUserViewPanelContext, spaces: number): string[] {
  if (panel.visibleOutline.length === 0) return [];
  const prefix = ' '.repeat(spaces);
  return [
    `${prefix}<visible-outline${xmlAttrs({
      format: 'lin',
      truncated: panel.visibleOutlineTruncated ? 'true' : null,
    })}>`,
    ...panel.visibleOutline.map(formatOutlineLine),
    `${prefix}</visible-outline>`,
  ];
}

function panelAttrs(panel: AgentUserViewPanelContext): Record<string, string | null> {
  return {
    id: panel.panelId,
    root_id: panel.rootNodeId,
    active: panel.active ? 'true' : null,
    focused: panel.focused ? 'true' : null,
    position: panel.order > 0 ? String(panel.order) : null,
    root_children: panel.childCount > 0 ? String(panel.childCount) : null,
    root_type: panel.rootType && panel.rootType !== 'outline' ? String(panel.rootType) : null,
  };
}

function nodeRefAttrs(node: AgentUserViewNodeContext): Record<string, string | null> {
  return {
    id: node.nodeId,
    title: node.title,
  };
}

function formatOutlineLine(node: AgentUserViewOutlineNodeContext): string {
  const annotation = [`node:${annotationValue(node.nodeId)}`];
  if (node.focused) annotation.push('focused');
  if (node.collapsed) annotation.push('collapsed');
  if (node.childCount && node.childCount > 0) annotation.push(`children=${node.childCount}`);
  if (node.partial && node.partial.total > 0) annotation.push(`partial=${node.partial.included}/${node.partial.total}`);
  return `${'  '.repeat(node.depth)}- %%${annotation.join(' ')}%% ${outlineText(node.title, 'Untitled')}`;
}

function xmlAttrs(attrs: Record<string, string | null | undefined>): string {
  const serialized = Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${key}="${escapeXml(value)}"`);
  return serialized.length ? ` ${serialized.join(' ')}` : '';
}

function annotationValue(value: string): string {
  return value.replace(/\s+/g, '_').replace(/%/g, '');
}

function outlineText(value: string, fallback = ''): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || fallback;
}
