import { describe, expect, test } from 'bun:test';
import {
  beliefsFromToolResult,
  driftedNodes,
  DocumentBeliefSet,
} from '../../src/main/agent/context/DocumentBeliefs';
import { ThreadDocumentBeliefs } from '../../src/main/agent/context/ThreadDocumentBeliefs';
import { indexProjection, revisionOf } from '../../src/main/agent/capabilities/agentNodeToolProjection';
import { editableOutlineRevision } from '../../src/main/agent/capabilities/agentNodeToolRead';
import { TRASH_ID, type DocumentProjection, type NodeProjection } from '../../src/core/types';

const ROOT = '019fb2da-0000-7000-8000-00000000000r';
/** The real system id, so `isInTrash` sees what it sees in the app. */
const TRASH = TRASH_ID;
const PRICING = '019fb2da-0000-7000-8000-000000000001';
const PLAN = '019fb2da-0000-7000-8000-000000000002';

/**
 * EVERY TOKEN IN THIS FILE COMES FROM THE FUNCTION THAT REALLY EMITS IT.
 *
 * The first version of these tests hand-wrote `${id}:${updatedAt}` because that
 * is what the implementation assumed `node_read` returned. It returns
 * `editableOutlineRevision`, which appends an outline hash, so the tests
 * confirmed the assumption instead of the behaviour and the feature shipped
 * unable to ever match. A fixture written from an assumption can only ever
 * agree with it.
 */
describe('document beliefs', () => {
  test('does not index the document for a tool that cannot express beliefs', () => {
    let projectionReads = 0;
    const projection = new Proxy(documentWith([]), {
      get(target, property, receiver) {
        if (property === 'nodes') projectionReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const beliefs = new ThreadDocumentBeliefs(() => 1, async () => []);

    beliefs.observe(
      '019fb2da-0000-7000-8000-00000000000a',
      'bash',
      { ok: true, data: { items: [] } },
      projection,
    );

    expect(projectionReads).toBe(0);
  });

  test('a belief compares against the function that produced it', () => {
    const projection = documentWith([textNode(PRICING, 'Enterprise ¥3,900/seat')]);
    const index = indexProjection(projection);

    const beliefs = beliefsFromToolResult(
      'node_read',
      // The shape node_read really emits, built by the emitter itself.
      { ok: true, data: { items: [{ nodeId: PRICING, revision: editableOutlineRevision(index, PRICING) }] } },
      index,
      1_000,
    );

    expect(beliefs).toEqual([
      { nodeId: PRICING, basis: 'outline', token: editableOutlineRevision(index, PRICING), trashed: false, observedAt: 1_000 },
    ]);
    // Unchanged document, no drift — the case the shipped version got wrong on
    // every single turn after every single read.
    expect(driftedNodes(beliefs, projection)).toEqual([]);
  });

  test('a search belief is the timestamp it rendered, normalised to compare', () => {
    const projection = documentWith([textNode(PLAN, 'Q3 plan', { updatedAt: 1_720_000_000_000 })]);
    const index = indexProjection(projection);

    const beliefs = beliefsFromToolResult(
      'node_search',
      // node_search renders an ISO string; the projection carries an epoch.
      { ok: true, data: { total: 1, items: [{ nodeId: PLAN, updatedAt: new Date(1_720_000_000_000).toISOString() }] } },
      index,
      1_000,
    );

    expect(beliefs[0]).toMatchObject({ nodeId: PLAN, basis: 'updatedAt', token: '1720000000000' });
    // A search that changed nothing must not plant one permanently-drifted
    // belief per result.
    expect(driftedNodes(beliefs, projection)).toEqual([]);
  });

  test('an edited node drifts on the basis it was observed on', () => {
    const before = documentWith([textNode(PRICING, 'Enterprise ¥3,900/seat')]);
    const beliefs = beliefsFromToolResult(
      'node_read',
      { ok: true, data: { items: [{ nodeId: PRICING, revision: editableOutlineRevision(indexProjection(before), PRICING) }] } },
      indexProjection(before),
      1_000,
    );

    const after = documentWith([textNode(PRICING, 'Enterprise ¥4,800/seat, 10% off annual')]);
    const drift = driftedNodes(beliefs, after);

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ nodeId: PRICING, kind: 'changed', observedAt: 1_000 });
  });

  test('a trashed node is gone, even though it stays in the projection', () => {
    // Trash is a subtree, not a removal: the node is still projected and
    // trashing does not stamp `updatedAt`, so neither absence nor a revision
    // bump would ever notice it. This is the flagship case of the whole feature.
    const before = documentWith([textNode(PRICING, 'Enterprise pricing')]);
    const beliefs = beliefsFromToolResult(
      'node_read',
      { ok: true, data: { items: [{ nodeId: PRICING, revision: editableOutlineRevision(indexProjection(before), PRICING) }] } },
      indexProjection(before),
      1_000,
    );

    const after = documentWith([textNode(PRICING, 'Enterprise pricing', { parentId: TRASH })]);
    const drift = driftedNodes(beliefs, after);

    expect(drift).toHaveLength(1);
    expect(drift[0]!.kind).toBe('gone');
  });

  test('classifies both revision forms node_edit emits, not just the outline one', () => {
    const projection = documentWith([textNode(PRICING, 'Enterprise pricing')]);
    const index = indexProjection(projection);

    // `node_edit` writes one `revisions` map from fifteen code paths. Only the
    // outline path emits the three-part form; the other thirteen emit
    // `revisionOf`. Both are built here by the functions that really emit them.
    const outlineForm = beliefsFromToolResult(
      'node_edit',
      { ok: true, data: { revisions: { [PRICING]: editableOutlineRevision(index, PRICING) } } },
      index,
      1_000,
    );
    const revisionForm = beliefsFromToolResult(
      'node_edit',
      { ok: true, data: { revisions: { [PRICING]: revisionOf(index.nodes.get(PRICING)!) } } },
      index,
      1_000,
    );

    expect(outlineForm[0]).toMatchObject({ basis: 'outline' });
    expect(revisionForm[0]).toMatchObject({ basis: 'updatedAt' });
    // Neither may report drift against the document they were emitted from —
    // labelling the whole map `outline` told the model its own move was someone
    // else's change it must not revert.
    expect(driftedNodes(outlineForm, projection)).toEqual([]);
    expect(driftedNodes(revisionForm, projection)).toEqual([]);

    // And both still notice a real edit.
    const after = documentWith([textNode(PRICING, 'Enterprise pricing', { updatedAt: 2 })]);
    expect(driftedNodes(outlineForm, after)).toHaveLength(1);
    expect(driftedNodes(revisionForm, after)).toHaveLength(1);
  });

  test('yields nothing rather than throwing on a shape it does not know', () => {
    const index = indexProjection(documentWith([textNode(PRICING, 'Pricing')]));
    // This runs behind a live tool call and behind a rebuild from persisted
    // payloads; neither may fail over an unrecognised or truncated result.
    expect(beliefsFromToolResult('bash', { ok: true, data: { items: [{ nodeId: PRICING, revision: 'x' }] } }, index, 1)).toEqual([]);
    expect(beliefsFromToolResult('node_read', null, index, 1)).toEqual([]);
    expect(beliefsFromToolResult('node_read', { ok: true, data: { items: 'truncated' } }, index, 1)).toEqual([]);
    // An item stating neither basis expresses no belief, rather than a belief
    // with a fabricated token.
    expect(beliefsFromToolResult('node_read', { ok: true, data: { items: [{ nodeId: PRICING }] } }, index, 1)).toEqual([]);
    // A revision that does not carry its node's id is a shape this does not
    // know; guessing its basis is what produced the defect it replaced.
    expect(beliefsFromToolResult(
      'node_edit',
      { ok: true, data: { revisions: { [PRICING]: 'something-else:1' } } },
      index,
      1,
    )).toEqual([]);
  });

  test('a re-observed node keeps one belief, and the newest one', () => {
    const beliefs = new DocumentBeliefSet();
    beliefs.record([belief(PRICING, 'a'), belief(PLAN, 'b')]);
    beliefs.record([belief(PRICING, 'c')]);

    expect(beliefs.size).toBe(2);
    // Recency last, because that is the order the notice spends its cap on.
    expect(beliefs.beliefs().map((entry) => [entry.nodeId, entry.token])).toEqual([
      [PLAN, 'b'],
      [PRICING, 'c'],
    ]);

    beliefs.forget([PLAN]);
    expect(beliefs.beliefs().map((entry) => entry.nodeId)).toEqual([PRICING]);
  });
});

function belief(nodeId: string, token: string) {
  return { nodeId, basis: 'outline' as const, token, trashed: false, observedAt: 1 };
}

function textNode(id: string, text: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    type: 'text',
    parentId: ROOT,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as unknown as NodeProjection;
}

function documentWith(nodes: NodeProjection[]): DocumentProjection {
  const root = textNode(ROOT, 'Root', { parentId: undefined, children: nodes.map((node) => node.id) });
  const trash = textNode(TRASH, 'Trash', { parentId: undefined, children: [] });
  return {
    workspaceId: 'workspace',
    rootId: ROOT,
    libraryId: ROOT,
    dailyNotesId: ROOT,
    schemaId: ROOT,
    searchesId: ROOT,
    recentsId: ROOT,
    trashId: TRASH,
    todayId: ROOT,
    nodes: [root, trash, ...nodes],
  };
}
