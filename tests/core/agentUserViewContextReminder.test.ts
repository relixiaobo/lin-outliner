import { describe, expect, test } from 'bun:test';
import type { AgentUserViewContext } from '../../src/core/agentTypes';
import { parseLinOutline } from '../../src/main/agentOutlineParser';
import { AgentUserViewContextReminderTracker, buildUserViewContextReminder } from '../../src/main/agentUserViewContextReminder';

describe('agent user view context reminder', () => {
  test('renders visible node panel content with inline annotation metadata', () => {
    const context = sampleContext();

    const reminder = buildUserViewContextReminder(context);

    expect(reminder).toContain('<user-view-context mode="snapshot">');
    expect(reminder).toContain('<current active_panel_id="panel-1" focused_panel_id="panel-1" focused_node_id="node-1" focus_surface="row" />');
    expect(reminder).toContain('<node-panel id="panel-1" root_id="root-1" active="true" focused="true" position="1" root_children="3">');
    expect(reminder).toContain('<visible-outline format="lin">');
    expect(reminder).toContain('- %%node:root-1%% Today');
    expect(reminder).toContain('  - %%node:node-1 focused%% Focused node');
    expect(reminder).toContain('  - %%node:node-2 collapsed children=3%% Collapsed branch');
    expect(reminder).toContain('  - %%node:node-3 partial=0/12%% Long branch');
    expect(reminder).not.toContain('<node-panel-state>');
    expect(reminder).not.toContain('<selection');
    expect(reminder).not.toContain('selected');
    expect(reminder).not.toContain('"nodePanels"');

    const outline = extractVisibleOutline(reminder ?? '');
    const parsed = parseLinOutline(outline, { annotations: 'allow' });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.document.roots[0]?.nodeId).toBe('root-1');
    expect(parsed.document.roots[0]?.children[0]?.nodeId).toBe('node-1');
    expect(parsed.document.roots[0]?.children[1]?.nodeId).toBe('node-2');
  });

  test('omits empty user view context', () => {
    expect(buildUserViewContextReminder({
      activePanelId: null,
      focusedPanelId: null,
      focusSurface: null,
      focusedNode: null,
      nodePanels: [],
    })).toBeNull();
  });

  test('renders explicit references even without visible panels', () => {
    const reminder = buildUserViewContextReminder({
      activePanelId: null,
      focusedPanelId: null,
      focusSurface: null,
      focusedNode: null,
      nodePanels: [],
      referencedNodes: [{ nodeId: 'node-ref-1', title: 'Referenced node' }],
    });

    expect(reminder).toContain('<explicit-references>');
    expect(reminder).toContain('<node-ref id="node-ref-1" title="Referenced node" />');
  });

  test('tracks per-conversation snapshots and sends diffs after the first view', () => {
    const tracker = new AgentUserViewContextReminderTracker();
    const first = tracker.prepare('conversation-1', sampleContext());
    expect(first.reminder).toContain('<user-view-context mode="snapshot">');
    first.commit();

    const unchanged = tracker.prepare('conversation-1', sampleContext());
    expect(unchanged.reminder).toContain('<user-view-context mode="diff" basis="previous-user-view-context">');
    expect(unchanged.reminder).toContain('<current active_panel_id="panel-1" focused_panel_id="panel-1" focused_node_id="node-1" focus_surface="row" />');
    expect(unchanged.reminder).not.toContain('<changes>');
    unchanged.commit();

    const changed = tracker.prepare('conversation-1', focusedOnCollapsedBranchContext());
    expect(changed.reminder).toContain('<focus-changed from_node_id="node-1" to_node_id="node-2" />');
    expect(changed.reminder).toContain('<panel-visible-outline-changed id="panel-1" root_id="root-1">');
    expect(changed.reminder).toContain('  - %%node:node-2 focused collapsed children=3%% Collapsed branch');

    const referenced = tracker.prepare('conversation-1', {
      ...focusedOnCollapsedBranchContext(),
      referencedNodes: [{ nodeId: 'node-ref-2', title: 'Second reference' }],
    });
    expect(referenced.reminder).toContain('<user-view-context mode="diff" basis="previous-user-view-context">');
    expect(referenced.reminder).toContain('<explicit-references>');
    expect(referenced.reminder).toContain('<node-ref id="node-ref-2" title="Second reference" />');

    tracker.reset('conversation-1');
    const afterReset = tracker.prepare('conversation-1', sampleContext());
    expect(afterReset.reminder).toContain('<user-view-context mode="snapshot">');
  });
});

function extractVisibleOutline(reminder: string): string {
  const match = /<visible-outline[^>]*>\n([\s\S]*?)\n\s*<\/visible-outline>/.exec(reminder);
  return match?.[1] ?? '';
}

function sampleContext(): AgentUserViewContext {
  return {
    activePanelId: 'panel-1',
    focusedPanelId: 'panel-1',
    focusSurface: 'row',
    focusedNode: {
      nodeId: 'node-1',
      title: 'Focused node',
      panelId: 'panel-1',
      surface: 'row',
    },
    nodePanels: [{
      panelId: 'panel-1',
      rootNodeId: 'root-1',
      rootTitle: 'Today',
      rootType: 'outline',
      active: true,
      focused: true,
      order: 1,
      childCount: 3,
      breadcrumb: [
        { nodeId: 'root-1', title: 'Today' },
        { nodeId: 'node-1', title: 'Focused node' },
      ],
      visibleOutline: [
        { nodeId: 'root-1', title: 'Today', depth: 0 },
        { nodeId: 'node-1', title: 'Focused node', depth: 1, focused: true },
        { nodeId: 'node-2', title: 'Collapsed branch', depth: 1, collapsed: true, childCount: 3 },
        { nodeId: 'node-3', title: 'Long branch', depth: 1, partial: { included: 0, total: 12 } },
      ],
      visibleOutlineTruncated: false,
    }],
  };
}

function focusedOnCollapsedBranchContext(): AgentUserViewContext {
  const context = sampleContext();
  context.focusedNode = {
    nodeId: 'node-2',
    title: 'Collapsed branch',
    panelId: 'panel-1',
    surface: 'row',
  };
  context.nodePanels[0]!.breadcrumb = [
    { nodeId: 'root-1', title: 'Today' },
    { nodeId: 'node-2', title: 'Collapsed branch' },
  ];
  context.nodePanels[0]!.visibleOutline = [
    { nodeId: 'root-1', title: 'Today', depth: 0 },
    { nodeId: 'node-1', title: 'Focused node', depth: 1 },
    { nodeId: 'node-2', title: 'Collapsed branch', depth: 1, focused: true, collapsed: true, childCount: 3 },
    { nodeId: 'node-3', title: 'Long branch', depth: 1, partial: { included: 0, total: 12 } },
  ];
  return context;
}
