import { describe, expect, test } from 'bun:test';
import type {
  TurnEnvironmentContextPayload,
  UserViewContextPayload,
  UserViewTargetSnapshot,
} from '../../src/core/agent/protocol';
import {
  environmentBrief,
  userViewBrief,
} from '../../src/main/agent/context/TurnBrief';

const NODE_KEY = '00000000-0000-4000-8000-000000000001';
const NODE_ID = `node:${NODE_KEY}`;
const THREAD_ID = '01a05af5-9c1e-7b47-872b-f3c0d70108ce';

describe('Agent Turn brief language', () => {
  test('describes every view target through readable identity without private renderer ids', () => {
    const targets: readonly [UserViewTargetSnapshot, string][] = [
      [nodeTarget('Plan'), `Viewing "Plan" [[node://${NODE_KEY}]] at Tenon / Plans.`],
      [{
        kind: 'local-file',
        path: '/workspace/brief.md',
        entryKind: 'file',
        label: 'brief.md',
        ownerNode: ownerNode(),
      }, `Viewing file "brief.md" [[file:///workspace/brief.md]], from "Source" [[node://${NODE_KEY}]].`],
      [{ kind: 'asset', assetId: 'private-asset', label: 'Diagram', ownerNode: ownerNode() },
        `Viewing asset "Diagram", from "Source" [[node://${NODE_KEY}]].`],
      [{
        kind: 'linked-file',
        sourceValueId: 'private-value',
        sourceText: 'file:///workspace/linked.md',
        label: 'linked.md',
        ownerNode: null,
      }, 'Viewing linked file "linked.md" [[file:///workspace/linked.md]].'],
      [{ kind: 'url', url: 'https://example.com/docs', label: 'Docs', ownerNode: null },
        'Viewing "Docs" at https://example.com/docs.'],
      [{
        kind: 'thread-trajectory',
        threadId: THREAD_ID,
        threadName: 'Context review',
        turnId: 'turn-visible',
        selectedRecordId: 'private-record',
      }, `Viewing trajectory for Thread "Context review" [[thread://${THREAD_ID}]], Turn turn-visible.`],
    ];

    for (const [target, expected] of targets) {
      const text = userViewBrief(null, view([panel('pane-private', 0, true, target)])).map((block) => block.body).join('\n');
      expect(text).toContain(expected);
      expect(text).not.toContain('pane-private');
      expect(text).not.toContain('private-asset');
      expect(text).not.toContain('private-value');
      expect(text).not.toContain('private-record');
      expect(text).not.toContain(NODE_ID);
    }
  });

  test('places the active view first and bounds other views in spatial order', () => {
    const payload = view([
      panel('left', 0, false, nodeTarget('Left')),
      panel('active-private', 2, true, nodeTarget('Active')),
      panel('middle', 1, false, nodeTarget('Middle')),
      panel('right', 3, false, nodeTarget('Right')),
      panel('omitted', 4, false, nodeTarget('Omitted')),
    ], 'active-private');

    const text = userViewBrief(null, payload)[0]?.body ?? '';
    expect(text).toStartWith('Viewing "Active"');
    expect(text).toContain('Other open views, left to right: "Left"');
    expect(text.indexOf('"Left"')).toBeLessThan(text.indexOf('"Middle"'));
    expect(text.indexOf('"Middle"')).toBeLessThan(text.indexOf('"Right"'));
    expect(text).not.toContain('"Omitted"');
    expect(text).not.toContain('active-private');
  });

  test('keeps viewed identity separate from supplied content and ignores layout-only owner changes', () => {
    const target: UserViewTargetSnapshot = {
      kind: 'asset',
      assetId: 'asset-private',
      label: 'Diagram',
      ownerNode: ownerNode('pane-a'),
    };
    const baseline = view([panel('pane-a', 0, true, target)]);
    const baselineText = userViewBrief(null, baseline).map((block) => block.body).join('\n');
    expect(baselineText).toContain('Viewing asset "Diagram"');
    expect(baselineText).not.toContain('Supplied');

    const layoutOnly = view([panel('pane-b', 0, true, {
      ...target,
      ownerNode: ownerNode('pane-b'),
    })], 'pane-b');
    expect(userViewBrief(baseline, layoutOnly)).toEqual([]);
  });

  test('omits invalid local references and non-HTTP URLs from model text', () => {
    const targets: UserViewTargetSnapshot[] = [
      { kind: 'local-file', path: 'relative/private.md', entryKind: 'file', label: 'private.md', ownerNode: null },
      { kind: 'url', url: 'javascript:alert(1)', label: 'Unsafe', ownerNode: null },
    ];
    const text = targets.map((target) => userViewBrief(null, view([panel('pane', 0, true, target)]))[0]?.body).join('\n');
    expect(text).toContain('Viewing file "private.md".');
    expect(text).toContain('Viewing URL "Unsafe".');
    expect(text).not.toContain('relative/private.md');
    expect(text).not.toContain('javascript:');
  });

  test('publishes compact local time every admission and working directory only on baseline or change', () => {
    const first = environment();
    const later = { ...first, acceptedAt: 2, localTime: '11:15:00' };
    const moved = { ...later, acceptedAt: 3, localTime: '11:16:00', workingDirectory: '/workspace/next' };

    expect(environmentBrief(null, first).body).toBe([
      'Local time at this input: 2026-09-01T11:14:11+08:00 [Asia/Shanghai].',
      'Working directory: /workspace.',
    ].join('\n'));
    expect(environmentBrief(first, later).body).toBe(
      'Local time at this input: 2026-09-01T11:15:00+08:00 [Asia/Shanghai].',
    );
    expect(environmentBrief(later, moved).body).toContain('Working directory: /workspace/next.');
  });

  test('is materially denser than the renderer-shaped baseline for the same facts', () => {
    const legacy = [
      'projection_mode=snapshot',
      'accepted_at=2026-09-01T03:14:11.592Z',
      'local_date=2026-09-01',
      'local_time=11:14:11',
      'timezone=Asia/Shanghai',
      'utc_offset_minutes=480',
      'locale=en-US',
      'working_directory=/workspace',
    ].join('\n');
    const brief = environmentBrief(null, environment()).body;
    expect(brief.length).toBeLessThan(legacy.length * 0.7);
    expect(brief).not.toContain('projection_mode');
  });
});

function view(
  panels: UserViewContextPayload['panels'],
  activePanelId = panels[0]?.panelId ?? null,
): UserViewContextPayload {
  return {
    schemaVersion: 1,
    kind: 'userView',
    activePanelId,
    focusedPanelId: activePanelId,
    focusSurface: null,
    focusedNode: null,
    selectedNodes: [],
    panels,
    suppliedOutline: [],
    truncated: false,
  };
}

function panel(
  panelId: string,
  order: number,
  active: boolean,
  target: UserViewTargetSnapshot,
): UserViewContextPayload['panels'][number] {
  return { panelId, order, active, focused: active, target };
}

function nodeTarget(title: string): UserViewTargetSnapshot {
  return {
    kind: 'node',
    nodeId: NODE_ID,
    title,
    rootType: 'outline',
    childCount: 0,
    breadcrumb: [
      { nodeId: 'workspace', title: 'Tenon', panelId: null, surface: null },
      { nodeId: NODE_ID, title: 'Plans', panelId: null, surface: null },
    ],
  };
}

function ownerNode(panelId: string | null = 'pane-private') {
  return { nodeId: NODE_ID, title: 'Source', panelId, surface: 'view-owner' };
}

function environment(): TurnEnvironmentContextPayload {
  return {
    schemaVersion: 1,
    kind: 'turnEnvironment',
    acceptedAt: 1,
    utcInstant: '2026-09-01T03:14:11.592Z',
    localDate: '2026-09-01',
    localTime: '11:14:11',
    timeZone: 'Asia/Shanghai',
    utcOffsetMinutes: 480,
    locale: 'en-US',
    workingDirectory: '/workspace',
    conversationMode: 'interactive',
    executionMode: 'root',
    replyIdentity: null,
    todayNodeId: NODE_ID,
    todayNodeTitle: 'Today',
  };
}
