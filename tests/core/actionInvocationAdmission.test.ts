// AC-02 / AC-06 / AC-10 / AC-11 — admission, generations, the challenge
// protocol, and the `Move to` retrieval convergence.
//
// The rule under test: a renderer may NAME an action; it may never author one.

import { describe, expect, test } from 'bun:test';
import {
  ActionInvocationService,
  type ActionInvocationHost,
} from '../../src/main/actionInvocationService';
import { admitsMoveToDestination, moveToEmptyQueryOrder } from '../../src/core/actions/candidates';
import type {
  ActionRequest,
  ArgumentSlot,
  InvocationOpened,
  InvocationRef,
  ObjectRef,
  RequestId,
} from '../../src/core/actions/types';
import { Core } from '../../src/core/core';
import { searchNodeText } from '../../src/main/nodeRetrievalService';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import type { NodeId } from '../../src/core/types';

const SENDER = 1;
const OTHER_SENDER = 2;

interface Harness {
  core: Core;
  service: ActionInvocationService;
  commands: { command: string; args: Record<string, unknown> }[];
  clipboard: string[];
  rendererSteps: unknown[];
}

function harness(overrides: Partial<ActionInvocationHost> = {}): Harness {
  const core = Core.new();
  const commands: Harness['commands'] = [];
  const clipboard: string[] = [];
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
    activateAppSurface: async () => undefined,
    writeClipboard: (text) => clipboard.push(text),
    untitled: () => 'Untitled',
    now: () => 1,
    ...overrides,
  };
  return { core, service: new ActionInvocationService(host), commands, clipboard, rendererSteps };
}

function open(h: Harness, anchorNodeId: NodeId, selectedIds: NodeId[] = []): InvocationOpened {
  const opened = h.service.openFromSeed({
    from: 'mainRenderer',
    anchorNodeId,
    visualRowId: anchorNodeId,
    panelId: 'panel-0',
    selectedIds,
    isPinned: false,
    rowExpanded: false,
  }, { webContentsId: SENDER, renderGeneration: 1 });
  if (!opened) throw new Error('open failed');
  return opened;
}

function subjectRefOf(opened: InvocationOpened, actionId: string): ObjectRef {
  const action = opened.menuActions.find((candidate) => candidate.actionId === actionId);
  if (!action) throw new Error(`no ${actionId}`);
  return action.subjectRef;
}

describe('invocation admission', () => {
  test('a seed for an unknown node is rejected outright', () => {
    const h = harness();
    const opened = h.service.openFromSeed({
      from: 'mainRenderer',
      anchorNodeId: 'node:does-not-exist',
      visualRowId: 'node:does-not-exist',
      panelId: 'p',
      selectedIds: [],
      isPinned: false,
      rowExpanded: false,
    }, { webContentsId: SENDER, renderGeneration: 1 });
    expect(opened).toBeNull();
  });

  test('a ref handed to one renderer is not consumable by another', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Alpha').focus!.nodeId;
    const opened = open(h, nodeId);
    const result = await h.service.request({
      actionId: 'copy',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'copy'),
      arguments: { representation: 'text' },
    }, OTHER_SENDER);
    expect(result).toEqual({ status: 'stale', reason: 'invocation' });
  });

  test('a fabricated subject ref is rejected without mutating', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Alpha').focus!.nodeId;
    const opened = open(h, nodeId);
    const result = await h.service.request({
      actionId: 'remove',
      invocationRef: opened.invocationRef,
      subjectRef: 'forged' as ObjectRef,
      arguments: {},
    }, SENDER);
    expect(result).toEqual({ status: 'stale', reason: 'subject' });
    expect(h.commands).toEqual([]);
  });

  test('an abandoned invocation is terminal', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Alpha').focus!.nodeId;
    const opened = open(h, nodeId);
    h.service.event({ kind: 'abandoned', invocationRef: opened.invocationRef }, SENDER);
    const result = await h.service.request({
      actionId: 'copy',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'copy'),
      arguments: { representation: 'text' },
    }, SENDER);
    expect(result).toEqual({ status: 'stale', reason: 'invocation' });
  });

  test('a claimed record refuses a second submit', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Alpha').focus!.nodeId;
    const opened = open(h, nodeId);
    const request: ActionRequest = {
      actionId: 'copy',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'copy'),
      arguments: { representation: 'text' },
    };
    const [first, second] = await Promise.all([
      h.service.request(request, SENDER),
      h.service.request(request, SENDER),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['completed', 'stale']);
    expect(h.clipboard).toEqual(['Alpha']);
  });
});

describe('the native confirmation sheet (flow B)', () => {
  function nativeHarness(accept: boolean) {
    const confirmations: unknown[] = [];
    const h = harness({ confirmNatively: async (spec) => { confirmations.push(spec); return accept; } });
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Gone').focus!.nodeId;
    h.core.trashNode(nodeId);
    return { h, confirmations, opened: open(h, nodeId) };
  }

  test('accepting runs the plan, and NO token was ever minted', async () => {
    const { h, confirmations, opened } = nativeHarness(true);
    const result = await h.service.request({
      actionId: 'deleteForever',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'deleteForever'),
      arguments: {},
    }, SENDER);
    expect(result.status).toBe('completed');
    expect(confirmations).toHaveLength(1);
    // Nothing was handed back for a renderer to redeem — the sheet IS the
    // decision, so a compromised renderer has nothing to replay.
    expect('challenge' in result).toBe(false);
    expect(h.commands.map((entry) => entry.command)).toEqual(['delete_node']);
  });

  test('cancelling runs nothing and returns the record to live', async () => {
    const { h, opened } = nativeHarness(false);
    const request = {
      actionId: 'deleteForever' as const,
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'deleteForever'),
      arguments: {},
    };
    const first = await h.service.request(request, SENDER);
    // A deliberate cancel is NOT a failure, and must be distinguishable from a
    // dead invocation — otherwise both surfaces show an error banner for doing
    // exactly what the user asked.
    expect(first).toEqual({ status: 'cancelled' });
    expect(h.commands).toEqual([]);
    // The record is live again, so the user can simply try once more.
    const second = await h.service.request(request, SENDER);
    expect(second).toEqual({ status: 'cancelled' });
  });

  test('a renderer cannot advance it by supplying a challenge', async () => {
    const { h, opened } = nativeHarness(false);
    const result = await h.service.request({
      actionId: 'deleteForever',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'deleteForever'),
      arguments: {},
      challenge: 'forged' as never,
    }, SENDER);
    // A forged token does not skip the sheet: flow B never consults one, so
    // the user still decided — and still declined.
    expect(result).toEqual({ status: 'cancelled' });
    expect(h.commands).toEqual([]);
  });

  test('closing the menu cannot kill the request the sheet is deciding', async () => {
    // The menu closes as soon as the action is chosen, and its unmount sends
    // `abandoned` — while main's native sheet is still on screen. Releasing the
    // record there would delete it out from under a decision the user is about
    // to accept.
    let resolveSheet: ((accepted: boolean) => void) | null = null;
    const h = harness({
      confirmNatively: () => new Promise((resolve) => { resolveSheet = resolve; }),
    });
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Gone').focus!.nodeId;
    h.core.trashNode(nodeId);
    const opened = open(h, nodeId);

    const pending = h.service.request({
      actionId: 'deleteForever',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'deleteForever'),
      arguments: {},
    }, SENDER);
    await Promise.resolve();
    h.service.event({ kind: 'abandoned', invocationRef: opened.invocationRef }, SENDER);
    resolveSheet!(true);

    expect((await pending).status).toBe('completed');
    expect(h.commands.map((entry) => entry.command)).toEqual(['delete_node']);
  });

  test('with no sheet available nothing runs', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const nodeId = h.core.createNode(today, null, 'Gone').focus!.nodeId;
    h.core.trashNode(nodeId);
    const opened = open(h, nodeId);
    const result = await h.service.request({
      actionId: 'deleteForever',
      invocationRef: opened.invocationRef,
      subjectRef: subjectRefOf(opened, 'deleteForever'),
      arguments: {},
    }, SENDER);
    // Fail CLOSED, and do NOT claim the user cancelled a sheet they never saw:
    // a missing host is a misconfiguration, not a decision.
    expect(result).toEqual({ status: 'stale', reason: 'invocation' });
    expect(h.commands).toEqual([]);
  });
});

describe('parameter object generations', () => {
  function moveFixture() {
    const h = harness();
    const today = h.core.projection().todayId;
    const moving = h.core.createNode(today, null, 'Moving').focus!.nodeId;
    const destination = h.core.createNode(today, null, 'Destination').focus!.nodeId;
    const opened = open(h, moving);
    const slot: ArgumentSlot = {
      actionId: 'move',
      subjectRef: subjectRefOf(opened, 'move'),
      parameterId: 'destination',
    };
    return { h, opened, slot, moving, destination };
  }

  test('candidates install in their exact slot and bind into the parent request', async () => {
    const { h, opened, slot, moving } = moveFixture();
    const result = h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot,
      requestId: 'r1' as RequestId,
      query: '',
    }, SENDER);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    // The moving row is never its own destination.
    expect(result.items.every((item) => item.name.source === 'literal')).toBe(true);
    const chosen = result.items[0]!;
    const executed = await h.service.request({
      actionId: 'move',
      invocationRef: opened.invocationRef,
      subjectRef: slot.subjectRef,
      arguments: { destination: chosen.objectRef },
    }, SENDER);
    expect(executed.status).toBe('completed');
    expect(h.commands[0]!.command).toBe('move_node');
    expect((h.commands[0]!.args as { nodeId: string }).nodeId).toBe(moving);
  });

  test('a stale generation is rejected by slot, never by backing identity', async () => {
    const { h, opened, slot } = moveFixture();
    const first = h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot,
      requestId: 'r1' as RequestId,
      query: '',
    }, SENDER);
    if (first.status !== 'ready') throw new Error('expected candidates');
    const staleRef = first.items[0]!.objectRef;
    // A second query replaces the generation for this slot.
    h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot,
      requestId: 'r2' as RequestId,
      query: '',
    }, SENDER);
    const executed = await h.service.request({
      actionId: 'move',
      invocationRef: opened.invocationRef,
      subjectRef: slot.subjectRef,
      arguments: { destination: staleRef },
    }, SENDER);
    expect(executed).toEqual({ status: 'stale', reason: 'argument' });
    expect(h.commands).toEqual([]);
  });

  test('a main-list subject ref cannot substitute for a destination ref', async () => {
    const { h, opened, slot } = moveFixture();
    h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot,
      requestId: 'r1' as RequestId,
      query: '',
    }, SENDER);
    const executed = await h.service.request({
      actionId: 'move',
      invocationRef: opened.invocationRef,
      subjectRef: slot.subjectRef,
      // The SUBJECT's own ref names the same kind of object and must still fail.
      arguments: { destination: slot.subjectRef },
    }, SENDER);
    expect(executed).toEqual({ status: 'stale', reason: 'argument' });
    expect(h.commands).toEqual([]);
  });

  test('a slot no action owns cannot be created by naming it', () => {
    const { h, opened } = moveFixture();
    const result = h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot: {
        actionId: 'capture',
        subjectRef: subjectRefOf(opened, 'move'),
        parameterId: 'destination',
      } as ArgumentSlot,
      requestId: 'r1' as RequestId,
      query: '',
    }, SENDER);
    expect(result.status).toBe('superseded');
  });

  test('a query against an unknown invocation is superseded', () => {
    const { h, slot } = moveFixture();
    const result = h.service.queryParameterObjects({
      invocationRef: 'nope' as InvocationRef,
      openSeq: null,
      slot,
      requestId: 'r1' as RequestId,
      query: '',
    }, SENDER);
    expect(result.status).toBe('superseded');
  });
});

describe('the anchored row, not the selection order', () => {
  test('a trashed row earlier in the selection cannot turn Remove into Delete forever', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const trashed = h.core.createNode(today, null, 'Trashed').focus!.nodeId;
    h.core.trashNode(trashed);
    const live = h.core.createNode(today, null, 'Live').focus!.nodeId;

    // Selection order puts the TRASHED row first; the user right-clicks the
    // LIVE one. Reading the selection's first root would offer permanent
    // deletion for a node that is not in Trash.
    const opened = open(h, live, [trashed, live]);
    const labels = opened.menuActions.map((action) => action.names.en);
    expect(labels).toContain('2 nodes: Move to Trash');
    expect(labels.some((label) => label.includes('Delete forever'))).toBe(false);
    expect(labels).not.toContain('Restore');
  });

  test('right-clicking a trashed row still offers Restore and Delete forever', () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const trashed = h.core.createNode(today, null, 'Trashed').focus!.nodeId;
    h.core.trashNode(trashed);
    const labels = open(h, trashed).menuActions.map((action) => action.names.en);
    expect(labels).toContain('Restore');
    expect(labels).toContain('Delete forever');
  });
});

describe('selection scope', () => {
  test('a selection that collapses to ONE root still acts on that root', async () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const parent = h.core.createNode(today, null, 'Parent').focus!.nodeId;
    const child = h.core.createNode(parent, null, 'Child').focus!.nodeId;

    // Select the parent and its child, then right-click the CHILD: collapsing
    // to roots yields [parent], and the shipped menu trashed the parent's whole
    // subtree rather than just the right-clicked child.
    const opened = open(h, child, [parent, child]);
    const remove = opened.menuActions.find((action) => action.actionId === 'remove')!;
    const result = await h.service.request({
      actionId: 'remove',
      invocationRef: opened.invocationRef,
      subjectRef: remove.subjectRef,
      arguments: {},
    }, SENDER);
    expect(result.status).toBe('completed');
    expect(h.commands).toEqual([
      { command: 'batch_trash_nodes', args: { nodeIds: [parent] } },
    ]);
  });
});

describe('Move to retrieval convergence', () => {
  test('admission runs BEFORE the limit, so a valid ranked destination survives', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const moving = core.createNode(today, null, 'Launch design').focus!.nodeId;
    // Fill the picker's limit with descendants of the moving row: filtering a
    // limited generic result would let them hide the valid destination below.
    for (let index = 0; index < 12; index += 1) {
      core.createNode(moving, null, `Launch design child ${index}`);
    }
    const valid = core.createNode(today, null, 'Launch design archive').focus!.nodeId;

    const byId = new Map(core.projection().nodes.map((node) => [node.id, node]));
    const hits = searchNodeText(
      core.projection(),
      buildTextSearchIndex(core.projection()),
      'Launch design',
      { limit: 200 },
    ).map((hit) => hit.nodeId);
    const admitted = hits.filter((candidateId) => admitsMoveToDestination({
      candidateId,
      moving: [moving],
      byId,
      trashId: core.projection().trashId,
    })).slice(0, 10);

    expect(admitted).toContain(valid);
    expect(admitted).not.toContain(moving);

    const naive = hits.slice(0, 10).filter((candidateId) => admitsMoveToDestination({
      candidateId,
      moving: [moving],
      byId,
      trashId: core.projection().trashId,
    }));
    // The defect this fixes, stated as a fact about the old order.
    expect(naive.includes(valid)).toBe(false);
  });

  test('a system container is still reachable by name', () => {
    const h = harness();
    const today = h.core.projection().todayId;
    const moving = h.core.createNode(today, null, 'Moving').focus!.nodeId;
    const opened = open(h, moving);
    const slot: ArgumentSlot = {
      actionId: 'move',
      subjectRef: opened.menuActions.find((action) => action.actionId === 'move')!.subjectRef,
      parameterId: 'destination',
    };
    const result = h.service.queryParameterObjects({
      invocationRef: opened.invocationRef,
      openSeq: null,
      slot,
      requestId: 'r1' as RequestId,
      query: 'Library',
    }, SENDER);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    // The ranked kernel drops system containers; routing the query through it
    // ALONE would have traded one hidden-destination defect for another.
    expect(result.items.map((item) => item.backingNodeId))
      .toContain(h.core.projection().libraryId);
  });

  test('an empty query returns candidates rather than nothing', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const moving = core.createNode(today, null, 'Moving').focus!.nodeId;
    core.createNode(today, null, 'Destination');
    const byId = new Map(core.projection().nodes.map((node) => [node.id, node]));
    const order = moveToEmptyQueryOrder({
      nodes: core.projection().nodes,
      moving: [moving],
      byId,
      trashId: core.projection().trashId,
      limit: 10,
    });
    expect(order.length).toBeGreaterThan(0);
    expect(order).not.toContain(moving);
    expect(order).not.toContain(core.projection().trashId);
  });
});
