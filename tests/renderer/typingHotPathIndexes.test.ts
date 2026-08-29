import { describe, expect, test } from 'bun:test';
import { buildReferenceSummary } from '../../src/core/references';
import { rankTextSearchLabel } from '../../src/core/textSearchAnalyzer';
import type {
  DocumentProjection,
  NodeId,
  NodeProjection,
  ProjectionUpdate,
} from '../../src/core/types';
import {
  buildIndex,
  reduceProjection,
  type DocumentIndex,
} from '../../src/renderer/state/document';
import { displayReachabilityForParent } from '../../src/renderer/state/displayReachability';
import { scanUnlinkedReferenceSources } from '../../src/renderer/state/cooperativeReferenceSummary';
import {
  buildReferenceCandidateIndexCooperatively,
  queryReferenceCandidateIndex,
  referenceCandidateIndexNeedsCompaction,
  type ReferenceCandidateQueryStats,
} from '../../src/renderer/state/referenceCandidateIndex';
import { buildReferenceCandidates } from '../../src/renderer/ui/interactions/referenceCandidates';
import {
  getTreeReferenceBlockReason,
  getTreeReferenceBlockReasonFromReachability,
} from '../../src/renderer/ui/interactions/referenceRules';

function node(id: NodeId, text = id, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function projection(nodes: NodeProjection[]): DocumentProjection {
  return {
    workspaceId: 'ws',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'root',
    nodes,
  };
}

function queryIndex(
  index: DocumentIndex,
  query: string,
  limit = 100,
  stats?: ReferenceCandidateQueryStats,
) {
  return queryReferenceCandidateIndex({
    index: index.referenceCandidates,
    query,
    untitledLabel: 'Untitled',
    limit,
    stats,
  });
}

function nodeIds(entries: readonly { id: NodeId }[]): NodeId[] {
  return entries.map((entry) => entry.id);
}

describe('typing hot-path reference candidate index', () => {
  test('matches exact contains semantics for short, CJK, and mid-word queries', () => {
    const candidates = [
      node('exact', 'ab', { updatedAt: 10 }),
      node('prefix', 'abacus', { updatedAt: 9 }),
      node('word-prefix', 'zero abacus', { updatedAt: 8 }),
      node('contains', 'grabbed', { updatedAt: 7 }),
      node('cjk', 'Record Shanghai weather', {
        content: { text: '记录上海天气', marks: [], inlineRefs: [] },
        updatedAt: 6,
      }),
      node('mid-word', 'encyclopedia', { updatedAt: 5 }),
      node('unrelated', 'quartz', { updatedAt: 4 }),
    ];
    const index = buildIndex(projection([
      node('root', 'Root', { children: candidates.map((candidate) => candidate.id).concat('trash') }),
      ...candidates.map((candidate) => ({ ...candidate, parentId: 'root' })),
      node('trash', 'Trash', { parentId: 'root' }),
    ]));

    for (const query of ['a', 'ab', '海', 'clo']) {
      const expected = candidates
        .filter((candidate) => rankTextSearchLabel(candidate.content.text, query))
        .map((candidate) => candidate.id)
        .sort();
      expect(nodeIds(queryIndex(index, query)).sort()).toEqual(expected);
    }
  });

  test('does not admit dense shared-gram false positives for a long query', () => {
    const query = 'abcdxyz';
    const falsePositiveText = 'abc bcd cdx dxy xyz';
    const falsePositives = Array.from({ length: 300 }, (_, index) => (
      node(`false-${index}`, `${falsePositiveText} ${index}`, { updatedAt: 1_000 - index })
    ));
    const matching = node('matching', `prefix ${query} suffix`, { updatedAt: 1 });
    const index = buildIndex(projection([
      node('root', 'Root', { children: [...falsePositives.map((candidate) => candidate.id), matching.id, 'trash'] }),
      ...falsePositives.map((candidate) => ({ ...candidate, parentId: 'root' })),
      { ...matching, parentId: 'root' },
      node('trash', 'Trash', { parentId: 'root' }),
    ]));
    const stats = { candidateEntriesVisited: 0, postingRangesRead: 0 };

    expect(nodeIds(queryIndex(index, query, 24, stats))).toEqual(['matching']);
    expect(stats.candidateEntriesVisited).toBe(1);
  });

  test('finds a tail substring in a long repeated label without copied suffix keys', () => {
    const longLabel = `${'a'.repeat(20_000)}needle-at-the-tail`;
    const index = buildIndex(projection([
      node('root', 'Root', { children: ['long', 'trash'] }),
      node('long', longLabel, { parentId: 'root', updatedAt: 10 }),
      node('trash', 'Trash', { parentId: 'root' }),
    ]));

    expect(nodeIds(queryIndex(index, 'needle-at-the-tail', 24))).toEqual(['long']);
    expect(nodeIds(queryIndex(index, 'aaaaaneedle', 24))).toEqual(['long']);
  });

  test('cooperatively rebuilds the complete candidate index across bounded work slices', async () => {
    const candidates = Array.from({ length: 240 }, (_, index) => node(
      `candidate-${index}`,
      `${'prefix '.repeat(index % 7)}Candidate ${index} middle-tail ${'x'.repeat(80)}`,
      { parentId: 'root', updatedAt: 1_000 - index },
    ));
    const document = projection([
      node('root', 'Root', { children: [...candidates.map((candidate) => candidate.id), 'trash'] }),
      ...candidates,
      node('trash', 'Trash', { parentId: 'root' }),
    ]);
    const expected = buildIndex(document);
    let yields = 0;
    const actualCandidates = await buildReferenceCandidateIndexCooperatively(
      expected.byId,
      expected.trashNodeIds,
      {
        chunkSize: 64,
        yieldControl: async () => { yields += 1; },
      },
    );

    expect(actualCandidates).not.toBeNull();
    expect(yields).toBeGreaterThan(10);
    const actual = { ...expected, referenceCandidates: actualCandidates! };
    for (const query of ['', 'candidate', 'middle-t', 'x'.repeat(40), '239']) {
      expect(queryIndex(actual, query, 24)).toEqual(queryIndex(expected, query, 24));
    }
  });

  test('keeps empty and universal-match queries within the shortlist visit bound', () => {
    const candidates = Array.from({ length: 2_000 }, (_, index) => (
      node(`candidate-${index}`, `a-${index}`, { updatedAt: index })
    ));
    const index = buildIndex(projection([
      node('root', 'Root', { children: [...candidates.map((candidate) => candidate.id), 'trash'] }),
      ...candidates.map((candidate) => ({ ...candidate, parentId: 'root' })),
      node('trash', 'Trash', { parentId: 'root' }),
    ]));

    for (const query of ['', 'a']) {
      const stats = { candidateEntriesVisited: 0, postingRangesRead: 0 };
      const first = queryIndex(index, query, 24, stats);
      const second = queryIndex(index, query, 24);
      expect(first).toHaveLength(24);
      expect(stats.candidateEntriesVisited).toBeLessThanOrEqual(24);
      expect(second).toEqual(first);

      const includedRanks = first.map((entry) => rankTextSearchLabel(entry.label, query)!.rank);
      const includedIds = new Set(nodeIds(first));
      const excludedRanks = candidates
        .filter((candidate) => !includedIds.has(candidate.id))
        .flatMap((candidate) => {
          const match = rankTextSearchLabel(candidate.content.text, query);
          return match ? [match.rank] : [];
        });
      expect(Math.max(...includedRanks)).toBeLessThanOrEqual(Math.min(...excludedRanks));
    }
  });

  test('matches deterministic rank and score order across a varied suffix corpus', () => {
    const candidates = Array.from({ length: 320 }, (_, index) => {
      const text = index % 5 === 0
        ? `${'a'.repeat(index % 19)} needle ${index}`
        : index % 5 === 1
          ? `Prefix_${index} middle-tail`
          : index % 5 === 2
            ? `记录上海天气 ${index}`
            : index % 5 === 3
              ? `zero/word.${index}-suffix`
              : `ordinary candidate ${index}`;
      return node(`candidate-${index}`, text, {
        parentId: 'root',
        updatedAt: (index * 37) % 503,
      });
    });
    const index = buildIndex(projection([
      node('root', 'Root', { children: [...candidates.map((candidate) => candidate.id), 'trash'] }),
      ...candidates,
      node('trash', 'Trash', { parentId: 'root' }),
    ]));

    for (const query of ['', 'a', 'needle', 'middle-t', '上海', 'word.', 'didate 2']) {
      const expected = candidates
        .flatMap((candidate) => {
          const match = rankTextSearchLabel(candidate.content.text, query);
          return match ? [{ candidate, match }] : [];
        })
        .sort((left, right) => {
          if (left.match.rank !== right.match.rank) return left.match.rank - right.match.rank;
          if (left.candidate.updatedAt !== right.candidate.updatedAt) {
            return right.candidate.updatedAt - left.candidate.updatedAt;
          }
          if (left.match.normalizedLabel.length !== right.match.normalizedLabel.length) {
            return left.match.normalizedLabel.length - right.match.normalizedLabel.length;
          }
          if (left.match.normalizedLabel !== right.match.normalizedLabel) {
            return left.match.normalizedLabel < right.match.normalizedLabel ? -1 : 1;
          }
          return left.candidate.id < right.candidate.id ? -1 : 1;
        })
        .slice(0, 24)
        .map(({ candidate }) => candidate.id);
      expect({ query, ids: nodeIds(queryIndex(index, query, 24)) }).toEqual({ query, ids: expected });
    }
  });

  test('incremental patches match a from-scratch candidate index across mutations', () => {
    const root = node('root', 'Root', { children: ['alpha', 'beta', 'trash'] });
    const trash = node('trash', 'Trash', { parentId: 'root' });
    const alpha = node('alpha', 'Alpha note', { parentId: 'root', updatedAt: 10 });
    const beta = node('beta', 'Beta note', { parentId: 'root', updatedAt: 20 });
    let state = reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection([root, alpha, beta, trash]),
    })!;

    const assertEquivalent = () => {
      const rebuilt = buildIndex(projection([...state.index.byId.values()]));
      for (const query of ['', 'a', 'note', 'renamed', '海']) {
        expect(queryIndex(state.index, query, 24)).toEqual(queryIndex(rebuilt, query, 24));
      }
    };
    assertEquivalent();

    const renamedBeta = node('beta', 'Renamed 上海 note', { parentId: 'root', updatedAt: 30 });
    state = reduceProjection(state, delta(2, [renamedBeta], []))!;
    assertEquivalent();

    const gamma = node('gamma', 'Gamma note', { parentId: 'root', updatedAt: 40 });
    const rootWithGamma = { ...state.index.byId.get('root')!, children: ['alpha', 'beta', 'gamma', 'trash'] };
    state = reduceProjection(state, delta(3, [rootWithGamma, gamma], []))!;
    assertEquivalent();

    const trashedBeta = { ...renamedBeta, parentId: 'trash' };
    const rootWithoutBeta = { ...rootWithGamma, children: ['alpha', 'gamma', 'trash'] };
    const trashWithBeta = { ...trash, children: ['beta'] };
    state = reduceProjection(state, delta(4, [rootWithoutBeta, trashWithBeta, trashedBeta], []))!;
    assertEquivalent();

    const rootWithoutAlpha = { ...rootWithoutBeta, children: ['gamma', 'trash'] };
    state = reduceProjection(state, delta(5, [rootWithoutAlpha], ['alpha']))!;
    assertEquivalent();
  });

  test('keeps repeated title edits in one overlay entry', () => {
    const editable = node('editable', 'Draft', { parentId: 'root', updatedAt: 10 });
    let state = reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection([
        node('root', 'Root', { children: ['editable', 'trash'] }),
        editable,
        node('trash', 'Trash', { parentId: 'root' }),
      ]),
    })!;
    const baseForest = state.index.referenceCandidates.content;

    for (let revision = 2; revision <= 40; revision += 1) {
      state = reduceProjection(state, delta(revision, [{
        ...editable,
        content: { ...editable.content, text: `Draft ${revision}` },
        updatedAt: revision,
      }], []))!;
    }

    expect(state.index.referenceCandidates.content).toBe(baseForest);
    expect(state.index.referenceCandidates.pending.size).toBe(1);
    const rebuilt = buildIndex(projection([...state.index.byId.values()]));
    for (const query of ['', 'draft', '40']) {
      expect(queryIndex(state.index, query, 24)).toEqual(queryIndex(rebuilt, query, 24));
    }
  });

  test('keeps an overflow overlay complete without rebuilding on the projection hot path', () => {
    const candidates = Array.from({ length: 60 }, (_, index) => (
      node(`candidate-${index}`, `Alpha ${index}`, {
        parentId: 'root',
        updatedAt: 1_000 - index,
      })
    ));
    let state = reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection([
        node('root', 'Root', { children: [...candidates.map((candidate) => candidate.id), 'trash'] }),
        ...candidates,
        node('trash', 'Trash', { parentId: 'root' }),
      ]),
    })!;
    const baseForest = state.index.referenceCandidates.content;
    const firstPatch = candidates.slice(0, 23).map((candidate, index) => ({
      ...candidate,
      content: { ...candidate.content, text: `Zulu ${index}` },
      updatedAt: 2_000 + index,
    }));
    state = reduceProjection(state, delta(2, firstPatch, []))!;

    expect(state.index.referenceCandidates.content).toBe(baseForest);
    expect(state.index.referenceCandidates.pending.size).toBe(23);
    const overlaidRebuild = buildIndex(projection([...state.index.byId.values()]));
    expect(queryIndex(state.index, 'alpha', 24)).toEqual(queryIndex(overlaidRebuild, 'alpha', 24));
    expect(queryIndex(state.index, 'alpha', 24)).toHaveLength(24);

    const compactedCandidate = {
      ...candidates[23]!,
      content: { ...candidates[23]!.content, text: 'Zulu compacted' },
      updatedAt: 3_000,
    };
    state = reduceProjection(state, delta(3, [compactedCandidate], []))!;

    expect(state.index.referenceCandidates.content).toBe(baseForest);
    expect(state.index.referenceCandidates.pending.size).toBe(24);
    expect(referenceCandidateIndexNeedsCompaction(state.index.referenceCandidates)).toBe(true);
    const overflowRebuild = buildIndex(projection([...state.index.byId.values()]));
    for (const query of ['', 'alpha', 'zulu', 'compacted']) {
      expect(queryIndex(state.index, query, 24)).toEqual(queryIndex(overflowRebuild, query, 24));
    }

    const secondPatch = candidates.slice(24, 50).map((candidate, index) => ({
      ...candidate,
      content: { ...candidate.content, text: `Omega ${index}` },
      updatedAt: 4_000 + index,
    }));
    state = reduceProjection(state, delta(4, secondPatch, []))!;
    expect(state.index.referenceCandidates.content).toBe(baseForest);
    expect(state.index.referenceCandidates.pending.size).toBe(50);
    const deepOverflowRebuild = buildIndex(projection([...state.index.byId.values()]));
    for (const query of ['', 'alpha', 'zulu', 'omega']) {
      expect(queryIndex(state.index, query, 24)).toEqual(queryIndex(deepOverflowRebuild, query, 24));
    }
  });
});

describe('typing hot-path semantic revisions and reachability', () => {
  test('offset-only inline-reference edits preserve the graph revision and linked summary', () => {
    const target = node('target', 'Target', { parentId: 'root' });
    const source = node('source', 'See Target', {
      parentId: 'root',
      content: {
        text: 'See Target',
        marks: [],
        inlineRefs: [{ offset: 4, target: { kind: 'node', nodeId: 'target' }, displayName: 'Target' }],
      },
    });
    const root = node('root', 'Root', { children: ['target', 'source', 'trash'] });
    const trash = node('trash', 'Trash', { parentId: 'root' });
    const first = reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection([root, target, source, trash]),
    })!;
    const shifted = {
      ...source,
      content: {
        ...source.content,
        text: 'Now See Target',
        inlineRefs: [{ offset: 8, target: { kind: 'node' as const, nodeId: 'target' }, displayName: 'Target' }],
      },
    };
    const second = reduceProjection(first, delta(2, [shifted], []))!;

    expect(second.index.semanticRevisions.referenceGraph)
      .toBe(first.index.semanticRevisions.referenceGraph);
    expect(second.index.referenceSummary).toBe(first.index.referenceSummary);

    const renamedInline = {
      ...shifted,
      content: {
        ...shifted.content,
        inlineRefs: [{ offset: 8, target: { kind: 'node' as const, nodeId: 'target' }, displayName: 'Target label' }],
      },
    };
    const third = reduceProjection(second, delta(3, [renamedInline], []))!;
    const rebuilt = buildIndex(projection([...third.index.byId.values()]));
    expect(third.index.semanticRevisions.referenceGraph)
      .toBe(second.index.semanticRevisions.referenceGraph);
    expect(third.index.referenceSummary).toEqual(rebuilt.referenceSummary);
  });

  test('a pure content subtree move invalidates display reachability without changing reference edges', () => {
    const root = node('root', 'Root', { children: ['parent', 'target', 'other', 'trash'] });
    const parent = node('parent', 'Parent', { parentId: 'root' });
    const target = node('target', 'Target', { parentId: 'root', children: ['child'] });
    const other = node('other', 'Other', { parentId: 'root' });
    const child = node('child', 'Child', { parentId: 'target' });
    const trash = node('trash', 'Trash', { parentId: 'root' });
    const first = reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection([root, parent, target, other, child, trash]),
    })!;
    const firstKey = first.index.displayGraphCacheKey;
    const movedTarget = { ...target, children: [] };
    const movedOther = { ...other, children: ['child'] };
    const movedChild = { ...child, parentId: 'other' };
    const second = reduceProjection(first, delta(2, [movedTarget, movedOther, movedChild], []))!;

    expect(second.index.semanticRevisions.referenceGraph)
      .not.toBe(first.index.semanticRevisions.referenceGraph);
    expect(second.index.semanticRevisions.structure)
      .toBe(first.index.semanticRevisions.structure + 1);
    expect(second.index.displayGraphCacheKey).not.toBe(firstKey);
  });

  test('builds reachability after yielding and reuses it for bounded candidate checks', async () => {
    const root = node('root', 'Root', { children: ['parent', 'target', 'safe', 'trash'] });
    const parent = node('parent', 'Parent', { parentId: 'root' });
    const target = node('target', 'Target', { parentId: 'root', children: ['to-parent'] });
    const toParent = node('to-parent', '', {
      type: 'reference',
      parentId: 'target',
      targetId: 'parent',
    });
    const safe = node('safe', 'Safe', { parentId: 'root' });
    const trash = node('trash', 'Trash', { parentId: 'root' });
    const index = buildIndex(projection([root, parent, target, toParent, safe, trash]));
    let settled = false;
    const pending = displayReachabilityForParent(index, 'parent');
    void pending.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(displayReachabilityForParent(index, 'parent')).toBe(pending);
    const reachability = await pending;

    for (const targetId of ['root', 'parent', 'target', 'safe']) {
      expect(getTreeReferenceBlockReasonFromReachability({
        parentId: 'parent',
        targetId,
        byId: index.byId,
        reachability,
      })).toBe(getTreeReferenceBlockReason({ parentId: 'parent', targetId, byId: index.byId }));
    }

    let checks = 0;
    const candidates = buildReferenceCandidates({
      index,
      currentNodeId: null,
      query: '',
      treeReferenceParentId: 'parent',
      excludeCurrentNode: false,
      resolveTreeReferenceBlockReason: (targetId) => {
        checks += 1;
        return getTreeReferenceBlockReasonFromReachability({
          parentId: 'parent',
          targetId,
          byId: index.byId,
          reachability,
        });
      },
    });
    expect(checks).toBeLessThanOrEqual(24);
    expect(candidates.find((candidate) => candidate.type === 'node' && candidate.id === 'target'))
      .toMatchObject({ disabledReason: 'Would create a display cycle' });
  });

  test('keeps checking direct children after a dangling reference', async () => {
    const root = node('root', 'Root', { children: ['parent', 'safe', 'trash'] });
    const parent = node('parent', 'Parent', {
      parentId: 'root',
      children: ['dangling', 'cycle-a'],
    });
    const dangling = node('dangling', '', {
      type: 'reference',
      parentId: 'parent',
      targetId: 'missing',
    });
    const cycleA = node('cycle-a', '', {
      type: 'reference',
      parentId: 'parent',
      targetId: 'cycle-b',
    });
    const cycleB = node('cycle-b', '', {
      type: 'reference',
      targetId: 'cycle-a',
    });
    const safe = node('safe', 'Safe', { parentId: 'root' });
    const trash = node('trash', 'Trash', { parentId: 'root' });
    const index = buildIndex(projection([root, parent, dangling, cycleA, cycleB, safe, trash]));
    const reachability = await displayReachabilityForParent(index, 'parent');

    expect(reachability.directChildCycle).toBe(true);
    expect(getTreeReferenceBlockReasonFromReachability({
      parentId: 'parent',
      targetId: 'safe',
      byId: index.byId,
      reachability,
    })).toBe(getTreeReferenceBlockReason({
      parentId: 'parent',
      targetId: 'safe',
      byId: index.byId,
    }));
    expect(getTreeReferenceBlockReason({
      parentId: 'parent',
      targetId: 'safe',
      byId: index.byId,
    })).toBe('would_create_display_cycle');
  });
});

describe('typing hot-path expanded reference scan', () => {
  test('matches the full unlinked scan while yielding between bounded node batches', async () => {
    const target = node('target', 'Project Atlas', { parentId: 'root' });
    const linked = node('linked', 'See Project Atlas', {
      parentId: 'root',
      content: {
        text: 'See Project Atlas',
        marks: [],
        inlineRefs: [{
          offset: 4,
          target: { kind: 'node', nodeId: 'target' },
          displayName: 'Project Atlas',
        }],
      },
    });
    const contentMention = node('content-mention', 'Discuss Project Atlas tomorrow', { parentId: 'root' });
    const descriptionMention = node('description-mention', 'Agenda', {
      parentId: 'root',
      description: 'Owner of Project Atlas',
    });
    const trashedMention = node('trashed-mention', 'Project Atlas old note', { parentId: 'trash' });
    const root = node('root', 'Root', {
      children: ['target', 'linked', 'content-mention', 'description-mention', 'trash'],
    });
    const trash = node('trash', 'Trash', { parentId: 'root', children: ['trashed-mention'] });
    const index = buildIndex(projection([
      root,
      target,
      linked,
      contentMention,
      descriptionMention,
      trash,
      trashedMention,
    ]));
    let yields = 0;

    const cooperative = await scanUnlinkedReferenceSources(index, 'target', {
      chunkSize: 1,
      yieldControl: async () => { yields += 1; },
    });
    const full = buildReferenceSummary(index.byId, {
      includeUnlinked: true,
      mentionTargetIds: ['target'],
      isDeleted: (nodeId) => index.trashNodeIds.has(nodeId),
    });
    const expected = (full.byTarget.get('target') ?? [])
      .filter((source) => source.kind === 'unlinked');

    expect(cooperative).toEqual(expected);
    expect(yields).toBeGreaterThan(1);
  });

  test('observes cancellation at the initial yield before scanning the document', async () => {
    const index = buildIndex(projection([
      node('root', 'Root', { children: ['target', 'source', 'trash'] }),
      node('target', 'Target title', { parentId: 'root' }),
      node('source', 'Target title mention', { parentId: 'root' }),
      node('trash', 'Trash', { parentId: 'root' }),
    ]));
    const controller = new AbortController();
    let releaseYield: (() => void) | undefined;
    const initialYield = new Promise<void>((resolve) => { releaseYield = resolve; });
    const pending = scanUnlinkedReferenceSources(index, 'target', {
      signal: controller.signal,
      yieldControl: () => initialYield,
    });

    controller.abort();
    releaseYield?.();
    expect(await pending).toBeNull();
  });
});

function delta(
  revision: number,
  changedNodes: NodeProjection[],
  removedIds: NodeId[],
): ProjectionUpdate {
  return { kind: 'delta', revision, todayId: 'root', changedNodes, removedIds };
}
