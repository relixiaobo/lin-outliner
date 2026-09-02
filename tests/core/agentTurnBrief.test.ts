import { describe, expect, test } from 'bun:test';
import type {
  TurnEnvironmentContextPayload,
  UserViewContextPayload,
  UserViewTargetSnapshot,
} from '../../src/core/agent/protocol';
import {
  compactionSummaryBrief,
  contextEntryBrief,
  contextRevocationBrief,
  degradationBrief,
  environmentBrief,
  historicalToolOutputBrief,
  referencedResourceBrief,
  roleCatalogBrief,
  skillCatalogBrief,
  skillInvocationBrief,
  suppliedFileBrief,
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

  test('does not invent an active or empty view when renderer targets are unresolved', () => {
    const partial = {
      ...view([panel('secondary', 1, false, nodeTarget('Resolved secondary'))], 'missing-active'),
      viewsComplete: false,
    };
    const partialText = userViewBrief(null, partial)[0]?.body ?? '';
    expect(partialText).toContain('Open views, left to right:');
    expect(partialText).toContain('Some open views could not be resolved.');
    expect(partialText).not.toContain('Viewing');

    const unresolved = { ...view([], null), viewsComplete: false };
    expect(userViewBrief(null, unresolved)[0]?.body).toBe(
      'The current application view could not be resolved.',
    );
  });

  test('clears focus honestly without an active view and marks bounded selection', () => {
    const prior = {
      ...view([panel('active', 0, true, nodeTarget('Active'))]),
      focusedNode: {
        nodeId: 'node:00000000-0000-4000-8000-000000000002',
        title: 'Distinct focus',
        panelId: null,
        surface: 'row',
      },
    };
    const cleared = view([], null);
    const clearedText = userViewBrief(prior, cleared).map((block) => block.body).join('\n');
    expect(clearedText).toContain('Focus cleared.');
    expect(clearedText).not.toContain('returned to the active view');

    const bounded = {
      ...view([panel('active', 0, true, nodeTarget('Active'))]),
      selectedNodes: [ownerNode(null)],
      selectionTruncated: true,
    };
    const boundedText = userViewBrief(null, bounded).map((block) => block.body).join('\n');
    expect(boundedText).toContain('Selected:');
    expect(boundedText).toContain('[Selection truncated.]');
  });

  test('emits a trailing insertion relation on the active Node', () => {
    const focusedNode = {
      nodeId: NODE_ID,
      title: 'Active',
      panelId: null,
      surface: 'row',
    };
    const focused = {
      ...view([panel('active', 0, true, nodeTarget('Active'))]),
      focusedNode,
      focusSurface: 'row',
    };
    const insertion = { ...focused, focusSurface: 'trailing' };

    expect(userViewBrief(focused, insertion).map((block) => block.body)).toContain(
      `Insertion target: children of "Active" [[node://${NODE_KEY}]].`,
    );
  });

  test('uses directory identity for supplied directory references and failures', () => {
    expect(suppliedFileBrief({
      fileName: 'assets',
      mimeType: 'inode/directory',
      byteLength: 0,
      readablePath: '/workspace/assets',
    }).body).toBe('Supplied directory assets: [[file:///workspace/assets/]] (inode/directory, 0 bytes).');
    expect(suppliedFileBrief({
      fileName: 'assets',
      mimeType: 'inode/directory',
      byteLength: 0,
      readablePath: null,
    }).body).toBe('Supplied directory "assets" is unavailable.');
  });

  test('separates degradation facts from recovery instructions', () => {
    expect(degradationBrief({
      code: 'payloadUnavailable',
      source: 'userView',
      reference: 'private-ref',
    })).toEqual([
      {
        authority: 'application',
        purpose: 'observation',
        body: 'user view could not be restored.',
      },
      {
        authority: 'application',
        purpose: 'instruction',
        body: 'Re-inspect current state before relying on the unavailable context.',
      },
    ]);
  });

  test('preserves observation authority when prior context is revoked', () => {
    expect(contextRevocationBrief({
      key: 'renderer:selection',
      source: 'renderer',
      authority: 'untrusted',
      purpose: 'observation',
      text: 'Quoted external state.',
      scope: 'external selection',
    })).toEqual({
      authority: 'untrusted',
      purpose: 'observation',
      body: 'The "external selection" context is no longer active.',
    });
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

  test('records density budgets for every brief family and a representative multi-Turn projection', () => {
    const instructionEntry = {
      key: 'memory:policy',
      source: 'extension:memory',
      authority: 'application' as const,
      purpose: 'instruction' as const,
      text: 'Use Memory only when the user explicitly requests it.',
      scope: 'Memory',
    };
    const catalogEntry = {
      change: 'available' as const,
      name: 'outline',
      displayName: 'Outline',
      description: 'Read and update Outliner Nodes.',
      identity: 'built-in:outline',
      contentHash: 'a'.repeat(64),
    };
    const skillCatalog = {
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: 'b'.repeat(64),
      entries: [catalogEntry],
    };
    const blocks = {
      environment: environmentBrief(null, environment()).body,
      view: userViewBrief(null, view([panel('active', 0, true, nodeTarget('Plan'))]))
        .map((block) => block.body).join('\n'),
      additionalContext: contextEntryBrief(instructionEntry).body,
      revocation: contextRevocationBrief(instructionEntry).body,
      suppliedFile: suppliedFileBrief({
        fileName: 'brief.md',
        mimeType: 'text/markdown',
        byteLength: 420,
        readablePath: '/workspace/brief.md',
      }).body,
      referencedResource: referencedResourceBrief({
        nodeId: NODE_ID,
        nodeType: 'outline',
        title: 'Plan',
        breadcrumb: [{ nodeId: 'workspace', title: 'Tenon', panelId: null, surface: null }],
        content: 'Implement the reviewed context contract.',
        contentTruncated: false,
        resourceRef: null,
        inlineImage: false,
        unavailableReason: null,
      }, null).body,
      skillCatalog: skillCatalogBrief(skillCatalog).body,
      roleCatalog: roleCatalogBrief({
        ...skillCatalog,
        kind: 'roleCatalog',
        entries: [{ ...catalogEntry, name: 'reviewer', displayName: 'Reviewer' }],
      }).body,
      skillInvocation: skillInvocationBrief({
        schemaVersion: 1,
        kind: 'skillInvocation',
        name: 'outline',
        displayName: 'Outline',
        source: 'built-in',
        identity: 'built-in:outline',
        resourceRoot: '/skills/outline',
        contentHash: 'c'.repeat(64),
        instructions: 'Use the Outline CLI as the only document access path.',
        arguments: '',
        execution: 'inline',
        invocationSource: 'model',
        constraints: { allowedTools: [], model: null, effort: null },
        invokedAt: 1,
      }).map((block) => block.body).join('\n'),
      compaction: compactionSummaryBrief('The context design was approved.').body,
      historicalOutput: historicalToolOutputBrief({
        tool: 'file_read',
        subject: '/workspace/brief.md',
        text: 'Approved requirements.',
      }).map((block) => block.body).join('\n'),
      degradation: degradationBrief({
        code: 'payloadUnavailable',
        source: 'userView',
        reference: 'private-ref',
      }).map((block) => block.body).join('\n'),
    };
    const multiTurn = [
      blocks.environment,
      blocks.view,
      blocks.skillCatalog,
      blocks.skillInvocation,
      environmentBrief(environment(), { ...environment(), localTime: '11:18:42' }).body,
      blocks.referencedResource,
      blocks.compaction,
    ].join('\n');
    const metrics = Object.fromEntries([
      ...Object.entries(blocks),
      ['multiTurn', multiTurn],
    ].map(([name, text]) => [name, {
      characters: text.length,
      estimatedTokens: Math.ceil(text.length / 4),
    }]));

    expect(metrics).toEqual({
      additionalContext: { characters: 53, estimatedTokens: 14 },
      compaction: { characters: 54, estimatedTokens: 14 },
      degradation: { characters: 100, estimatedTokens: 25 },
      environment: { characters: 99, estimatedTokens: 25 },
      historicalOutput: { characters: 170, estimatedTokens: 43 },
      multiTurn: { characters: 600, estimatedTokens: 150 },
      referencedResource: { characters: 137, estimatedTokens: 35 },
      revocation: { characters: 40, estimatedTokens: 10 },
      roleCatalog: { characters: 77, estimatedTokens: 20 },
      skillCatalog: { characters: 70, estimatedTokens: 18 },
      skillInvocation: { characters: 86, estimatedTokens: 22 },
      suppliedFile: { characters: 82, estimatedTokens: 21 },
      view: { characters: 80, estimatedTokens: 20 },
    });
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
    viewsComplete: true,
    selectionTruncated: false,
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
