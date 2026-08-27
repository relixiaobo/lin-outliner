// AC-14 — the capture loop, through the registry rather than a bespoke handler.
//
// The shipped `launcher:createContextCapture` is gone; capture is now
// `capture(page)` with Today as a BOUND destination object and an optional tag
// argument, planned as an ordered effect with real result binding.

import { describe, expect, test } from 'bun:test';
import {
  ActionInvocationService,
  type ActionInvocationHost,
} from '../../src/main/actionInvocationService';
import type {
  ArgumentSlot,
  ExternalContextId,
  InvocationOpened,
  ObjectRef,
  RequestId,
} from '../../src/core/actions/types';
import type { ExternalContext } from '../../src/core/launcher/context';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import { searchNodeText } from '../../src/main/nodeRetrievalService';

const LAUNCHER = 9;
const CONTEXT_ID = 'ctx-1' as ExternalContextId;

function pageContext(): ExternalContext {
  return {
    id: CONTEXT_ID,
    capturedAt: '2026-08-08T00:00:00',
    captureOrigin: 'global-hotkey',
    app: { name: 'Safari' },
    browser: { name: 'Safari', hostname: 'example.com', url: 'https://example.com/post' },
    providerId: 'generic-webpage',
    confidence: 'probable',
    source: {
      kind: 'article',
      title: 'An Example Article',
      original: { kind: 'remote-url', url: 'https://example.com/post', preview: 'web-preview' },
      url: 'https://example.com/post',
      providerId: 'generic-webpage',
    },
    warnings: [],
    permissions: [],
  } as ExternalContext;
}

function harness(options: { withContext?: boolean } = {}) {
  const core = Core.new();
  const commands: { command: string; args: Record<string, unknown> }[] = [];
  const context = options.withContext === false ? null : pageContext();
  const host: ActionInvocationHost = {
    projection: () => core.projection(),
    runCommand: async (command, args) => {
      commands.push({ command, args });
      // Real producers return `focus`, which is what the descriptor binds to.
      if (command === 'ensure_date_node') return { focus: { nodeId: 'day-node', selectAll: false } };
      if (command === 'create_capture') return { focus: { nodeId: 'capture-node', selectAll: false } };
      if (command === 'create_tag') return { focus: { nodeId: 'tag-node', selectAll: false } };
      return {};
    },
    searchNodes: (query, limit) => searchNodeText(
      core.projection(),
      buildTextSearchIndex(core.projection()),
      query,
      { limit },
    ),
    executeRendererStep: async () => ({ status: 'ok' }),
    activateAppSurface: async () => undefined,
    writeClipboard: () => undefined,
    untitled: () => 'Untitled',
    now: () => 1,
    externalContext: (contextId) => (context && context.id === contextId ? context : null),
    describeExternalPage: () => ({ title: 'An Example Article', subtitle: 'example.com' }),
    newCaptureId: () => 'cap:fixed',
  };
  return { core, commands, service: new ActionInvocationService(host) };
}

describe('the ambient page chip', () => {
  test('resolves into a fixed object with its own presentation', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: { kind: 'externalPage', contextId: CONTEXT_ID },
    });
    expect(change.status).toBe('updated');
    if (change.status !== 'updated') return;
    expect(change.ambientState).toBe('resolved');
    expect(change.fixedItems).toHaveLength(1);
    const chip = change.fixedItems[0]!;
    // The chip is the same ObjectPresentation a row uses — page title and where
    // it came from, not a raw context id.
    expect(chip.object.name).toEqual({ source: 'literal', value: 'An Example Article' });
    expect(chip.object.subtitle).toEqual({ source: 'literal', value: 'example.com' });
    expect(chip.object.typeLabel.en).toBe('Page');
    // Its primary action is an object contract: a page captures.
    expect(chip.primaryAction?.actionId).toBe('capture');
    expect(chip.primaryAction?.names.en).toBe('Capture');
  });

  test('a resolution for a stale opening changes no membership', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 2,
      resolution: { kind: 'externalPage', contextId: CONTEXT_ID },
    });
    expect(change.status).toBe('superseded');
  });

  test('capture failing to resolve records `none` rather than a phantom chip', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: { kind: 'none' },
    });
    expect(change.status).toBe('updated');
    if (change.status !== 'updated') return;
    expect(change.ambientState).toBe('none');
    expect(change.fixedItems).toEqual([]);
  });
});

describe('capture(page)', () => {
  function withPage() {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: { kind: 'externalPage', contextId: CONTEXT_ID },
    });
    if (change.status !== 'updated') throw new Error('expected the chip');
    return { h, opened, chip: change.fixedItems[0]! };
  }

  test('ensures the day node and binds it as the capture destination', async () => {
    const { h, opened, chip } = withPage();
    const result = await h.service.request({
      actionId: 'capture',
      invocationRef: opened.invocationRef,
      subjectRef: chip.object.objectRef,
      arguments: (chip.primaryAction!.binding as { arguments: never }).arguments,
    }, LAUNCHER);
    expect(result.status).toBe('completed');
    expect(h.commands.map((entry) => entry.command)).toEqual(['ensure_date_node', 'create_capture']);
    // The destination is the id `ensure_date_node` RETURNED, extracted through
    // the descriptor path — not a value the renderer supplied.
    const input = (h.commands[1]!.args as { input: { destinationParentId: string } }).input;
    expect(input.destinationParentId).toBe('day-node');
  });

  test('the typed text becomes the capture note without ever being a subject', async () => {
    const { h, opened, chip } = withPage();
    // Typing admits payload; it does not select anything.
    await h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'worth re-reading',
    }, LAUNCHER);
    const result = await h.service.request({
      actionId: 'capture',
      invocationRef: opened.invocationRef,
      subjectRef: chip.object.objectRef,
      arguments: (chip.primaryAction!.binding as { arguments: never }).arguments,
    }, LAUNCHER);
    expect(result.status).toBe('completed');
    // The shipped shape: the note nests UNDER the capture as its own child
    // bullet, not as the node description — the headline stays the source title.
    const input = (h.commands[1]!.args as {
      input: { children?: { content: { text: string } }[] };
    }).input;
    expect(input.children?.[0]?.content.text).toBe('worth re-reading');
  });

  test('the page chip survives a main-list query that replaces every result', async () => {
    const { h, opened, chip } = withPage();
    h.service.queryObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      requestId: 'r1' as RequestId,
      query: 'zzzz-nothing-matches',
    }, LAUNCHER);
    // The resolver-owned Today destination for the FIXED page is untouched by a
    // main-list query: changing a note query cannot invalidate it.
    const result = await h.service.request({
      actionId: 'capture',
      invocationRef: opened.invocationRef,
      subjectRef: chip.object.objectRef,
      arguments: (chip.primaryAction!.binding as { arguments: never }).arguments,
    }, LAUNCHER);
    expect(result.status).toBe('completed');
  });

  test('a tag candidate binds create-then-apply onto the captured node', async () => {
    const { h, opened, chip } = withPage();
    const slot: ArgumentSlot = {
      actionId: 'capture',
      subjectRef: chip.object.objectRef,
      parameterId: 'tag',
    };
    const candidates = await h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      slot,
      requestId: 'r1' as RequestId,
      query: 'reading',
    }, LAUNCHER);
    expect(candidates.status).toBe('ready');
    if (candidates.status !== 'ready') return;
    const draft = candidates.items.find((item) => item.kind === 'draft')!;
    expect(draft).toBeDefined();

    const base = (chip.primaryAction!.binding as { arguments: { destination: ObjectRef } }).arguments;
    const result = await h.service.request({
      actionId: 'capture',
      invocationRef: opened.invocationRef,
      subjectRef: chip.object.objectRef,
      arguments: { destination: base.destination, tag: draft.objectRef },
    }, LAUNCHER);
    expect(result.status).toBe('completed');
    expect(h.commands.map((entry) => entry.command))
      .toEqual(['ensure_date_node', 'create_capture', 'create_tag', 'apply_tag']);
    // Both references resolve through `ACTION_BINDINGS.produces`, not a special
    // case: the tag is applied to the node `create_capture` returned.
    expect(h.commands[3]!.args).toEqual({ nodeId: 'capture-node', tagId: 'tag-node' });
  });

  test('capture is ABSENT when no captured page backs the object', () => {
    const h = harness({ withContext: false });
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: { kind: 'externalPage', contextId: CONTEXT_ID },
    });
    if (change.status !== 'updated') throw new Error('expected the chip');
    // The subject it is defined relative to genuinely is not there, so the
    // action is absent rather than rejected.
    expect(change.fixedItems[0]?.primaryAction).toBeUndefined();
  });
});

describe('the in-app ambient object', () => {
  test('a validated seed becomes a node chip, built by MAIN', () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const focused = h.core.createNode(today, null, 'Focused').focus!.nodeId;
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: {
        kind: 'inApp',
        seed: {
          from: 'mainRenderer',
          anchorNodeId: focused,
          visualRowId: focused,
          panelId: 'panel-0',
          selectedIds: [],
          isPinned: false,
          rowExpanded: false,
        },
      },
    });
    expect(change.status).toBe('updated');
    if (change.status !== 'updated') return;
    const chip = change.fixedItems[0]!;
    expect(chip.object.kind).toBe('node');
    expect(chip.object.name).toEqual({ source: 'literal', value: 'Focused' });
    // A node's primary is `open`, not a mutation: an ambient node must never
    // occupy a blind-Enter slot with something that changes existing data.
    expect(chip.primaryAction?.actionId).toBe('open');
  });

  test('a multi-selection becomes ONE aggregate chip with no primary action', () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const first = h.core.createNode(today, null, 'First').focus!.nodeId;
    const second = h.core.createNode(today, null, 'Second').focus!.nodeId;
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: {
        kind: 'inApp',
        seed: {
          from: 'mainRenderer',
          anchorNodeId: first,
          visualRowId: first,
          panelId: 'panel-0',
          selectedIds: [first, second],
          isPinned: false,
          rowExpanded: false,
        },
      },
    });
    if (change.status !== 'updated') throw new Error('expected the chip');
    expect(change.fixedItems).toHaveLength(1);
    expect(change.fixedItems[0]!.object.kind).toBe('nodeSelection');
    // Enter is INERT for a selection — it has no safe canonical activation, and
    // the model does not invent "open the first one" to fill the slot.
    expect(change.fixedItems[0]!.primaryAction).toBeUndefined();
  });

  test('a seed naming a node that is gone records `none`', () => {
    const h = harness();
    const opened = h.service.openLauncher({ openSeq: 1, consumerId: LAUNCHER });
    const change = h.service.resolveAmbient({
      invocationRef: opened.invocationRef,
      openSeq: 1,
      resolution: {
        kind: 'inApp',
        seed: {
          from: 'mainRenderer',
          anchorNodeId: 'node:gone',
          visualRowId: 'node:gone',
          panelId: 'panel-0',
          selectedIds: [],
          isPinned: false,
          rowExpanded: false,
        },
      },
    });
    if (change.status !== 'updated') throw new Error('expected a resolution');
    expect(change.ambientState).toBe('none');
    expect(change.fixedItems).toEqual([]);
  });
});
