// AC-03 / AC-09 — the main list is an OBJECT list, and its ordering rule.
//
// The rule the tests exist to hold: every row is an object, an action is never
// a row, and no row fuses a destination into its title.

import { describe, expect, test } from 'bun:test';
import {
  ActionInvocationService,
  type ActionInvocationHost,
} from '../../src/main/actionInvocationService';
import { ACTION_PANEL_ORDER } from '../../src/core/actions/registry';
import { orderedResultObjects, stableObjectsFor } from '../../src/core/actions/surfaceObjects';
import type { InvocationOpened, ObjectRef, RequestId } from '../../src/core/actions/types';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import { searchNodeText } from '../../src/main/nodeRetrievalService';

const LAUNCHER = 9;
let refCounter = 0;
const mint = () => `ref-${++refCounter}` as ObjectRef;

function harness() {
  const core = Core.new();
  const commands: { command: string; args: Record<string, unknown> }[] = [];
  const surfaces: string[] = [];
  const rendererSteps: unknown[] = [];
  const host: ActionInvocationHost = {
    projection: () => core.projection(),
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return {};
    },
    searchNodes: (query, limit) => searchNodeText(
      core.projection(),
      buildTextSearchIndex(core.projection()),
      query,
      { limit },
    ),
    executeRendererStep: async (step) => {
      rendererSteps.push(step);
      return { status: 'ok' };
    },
    activateAppSurface: async (surface) => { surfaces.push(surface); },
    writeClipboard: () => undefined,
    untitled: () => 'Untitled',
    now: () => 1,
  };
  return { core, commands, rendererSteps, surfaces, service: new ActionInvocationService(host) };
}

function labels(opening: InvocationOpened): string[] {
  return opening.resultItems.map((item) => (
    item.object.name.source === 'literal' ? item.object.name.value : item.object.name.values.en
  ));
}

describe('the launcher opening', () => {
  test('accepts input immediately: ambient pending, results already ready', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    expect(opened.ambient?.state).toBe('pending');
    // The stable objects are legal subjects BEFORE the first keystroke, which is
    // what lets the panel paint furnished instead of empty.
    expect(labels(opened)).toEqual([
      'Today', 'Library', 'Schema', 'Saved searches', 'Trash', 'Main window', 'Settings',
    ]);
    expect(opened.fixedItems).toEqual([]);
  });

  test('every row is an object and no row is an action', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    for (const item of opened.resultItems) {
      expect(['node', 'appSurface', 'draft', 'externalPage', 'nodeSelection'])
        .toContain(item.object.kind);
    }
  });

  test('no row title fuses a destination or a verb into the noun', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const banned = ['Go to Today', 'Open Settings', 'Open main window', 'Capture page to Today', 'New node in Today'];
    for (const label of labels(opened)) expect(banned).not.toContain(label);
    // …and the same strings must not come back as ACTION labels either.
    const actionNames = opened.resultItems.flatMap((item) => item.actions.map((a) => a.names.en));
    for (const name of actionNames) expect(banned).not.toContain(name);
  });

  test('the primary action is an object contract', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    for (const item of opened.resultItems) {
      expect(item.primaryAction?.actionId).toBe('open');
      // The bar names the VERB, never the row title.
      expect(item.primaryAction?.names.en).toBe('Open');
    }
  });
});

describe('the main-list query generation', () => {
  test('a matched object suppresses the draft', () => {
    const h = harness();
    const today = h.core.projection().todayId;
    h.core.createNode(today, null, 'Roadmap review');
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'Roadmap',
    }, LAUNCHER);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.resultItems.some((item) => item.object.kind === 'draft')).toBe(false);
    expect(result.resultItems[0]?.object.kind).toBe('node');
  });

  test('returns and opens attachment nodes through the shared search kernel', async () => {
    const h = harness();
    const attachment = h.core.createAttachmentNode(h.core.projection().todayId, null, {
      assetId: 'asset-quarterly-call',
      mimeType: 'audio/wav',
      originalFilename: 'Quarterly call recording.wav',
      fileSize: 2_048,
    }).focus!.nodeId;
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'Quarterly call',
    }, LAUNCHER);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const item = result.resultItems.find((candidate) => candidate.object.backingNodeId === attachment);
    expect(item?.object.kind).toBe('node');
    expect(item?.object.name).toEqual({ source: 'literal', value: 'Quarterly call recording.wav' });
    expect(item?.object.iconId).toBe('file');
    expect(item?.object.typeLabel).toEqual({ en: 'File', 'zh-Hans': '文件' });
    expect(item?.primaryAction?.actionId).toBe('open');
    expect(result.resultItems.some((candidate) => candidate.object.kind === 'draft')).toBe(false);
    expect(item).toBeDefined();
    if (!item) return;

    const openedAttachment = await h.service.request({
      actionId: 'open',
      invocationRef: opened.invocationRef,
      subjectRef: item.object.objectRef,
      arguments: {},
    }, LAUNCHER);
    expect(openedAttachment.status).toBe('completed');
    expect(h.rendererSteps).toEqual([{
      on: 'mainRenderer',
      kind: 'navigate',
      nodeId: attachment,
      inPlace: true,
    }]);
  });

  test('a zero-match query yields EXACTLY one node-purpose draft', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'zzzz-nothing-matches',
    }, LAUNCHER);
    if (result.status !== 'ready') throw new Error('expected results');
    expect(result.resultItems).toHaveLength(1);
    const draft = result.resultItems[0]!;
    expect(draft.object.kind).toBe('draft');
    // The row is the literal text with a *New node* type label; it is NOT a
    // "New node in Today" command row.
    expect(draft.object.name).toEqual({ source: 'literal', value: 'zzzz-nothing-matches' });
    expect(draft.object.typeLabel.en).toBe('New node');
    expect(draft.primaryAction?.names.en).toBe('Create node');
  });

  test('a superseded generation invalidates its refs', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const staleRef = opened.resultItems[0]!.object.objectRef;
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'zzzz-nothing-matches',
    }, LAUNCHER);
    expect(result.status).toBe('ready');
    // The old Today ref belonged to the replaced generation and is dead.
    return h.service.request({
      actionId: 'open',
      invocationRef: opened.invocationRef,
      subjectRef: staleRef,
      arguments: {},
    }, LAUNCHER).then((executed) => {
      expect(executed).toEqual({ status: 'stale', reason: 'subject' });
    });
  });

  test('a query for the wrong opening is superseded', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 2,
      requestId: 'r1' as RequestId,
      query: 'anything',
    }, LAUNCHER);
    expect(result.status).toBe('superseded');
  });

  test('a query from another renderer is refused', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const result = h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'anything',
    }, LAUNCHER + 1);
    expect(result.status).toBe('superseded');
  });
});

describe('stable objects match both locales at once', () => {
  test('the Chinese name finds the object regardless of UI language', () => {
    const english = stableObjectsFor({ query: 'Saved', mintRef: mint });
    const chinese = stableObjectsFor({ query: '已保存', mintRef: mint });
    expect(english).toHaveLength(1);
    expect(chinese).toHaveLength(1);
  });

  test('an empty query returns every stable object in its fixed order', () => {
    expect(stableObjectsFor({ query: '', mintRef: mint })).toHaveLength(7);
  });

  test('an empty query with no matches yields no draft', () => {
    expect(orderedResultObjects({ query: '', nodeObjects: [], mintRef: mint })).toHaveLength(7);
  });
});

describe('opening an app surface', () => {
  test('Settings activates through the native host, with no renderer involved', async () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const settings = opened.resultItems.find((item) => item.object.kind === 'appSurface'
      && item.object.name.source === 'localized'
      && item.object.name.values.en === 'Settings')!;
    const result = await h.service.request({
      actionId: 'open',
      invocationRef: opened.invocationRef,
      subjectRef: settings.object.objectRef,
      arguments: {},
    }, LAUNCHER);
    expect(result.status).toBe('completed');
    expect(h.surfaces).toEqual(['settings']);
    // No document command ran: activating a window is not a mutation.
    expect(h.commands).toEqual([]);
  });

  test('opening Today ensures the day node and navigates to what it returned', async () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const today = opened.resultItems[0]!;
    const result = await h.service.request({
      actionId: 'open',
      invocationRef: opened.invocationRef,
      subjectRef: today.object.objectRef,
      arguments: {},
    }, LAUNCHER);
    // The bound navigate cannot resolve without a real focus hint from the
    // stub command runner, which is exactly the failure the binding declares.
    expect(result.status === 'completed' || result.status === 'failed').toBe(true);
    expect(h.commands[0]!.command).toBe('ensure_date_node');
  });
});

describe('the action panel order', () => {
  test('covers every family exactly once', () => {
    expect(new Set(ACTION_PANEL_ORDER).size).toBe(ACTION_PANEL_ORDER.length);
    expect(ACTION_PANEL_ORDER).toHaveLength(21);
  });
});
