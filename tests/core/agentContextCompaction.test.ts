import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type {
  ContextEvidenceThreadItem,
  JsonValue,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  Turn,
} from '../../src/core/agent/protocol';
import { planContextCompaction } from '../../src/main/agent/context/ContextCompaction';
import { uuidV7 } from '../../src/main/agent/uuid';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

describe('context compaction reducer', () => {
  test('invalidates Node observations after successful document mutations and undo', async () => {
    const store = createPayloadStore();
    const nodes = observation(
      store,
      'node-read-ab',
      'node_read',
      { node_ids: ['node-a', 'node-b'] },
      'Node snapshots A and B',
    );
    const file = observation(
      store,
      'file-read',
      'file_read',
      { file_path: '/workspace/notes.md' },
      'File snapshot',
    );
    const nodeAfterEdit = observation(
      store,
      'node-read-c',
      'node_read',
      { node_id: 'node-c' },
      'Node snapshot C',
    );
    const turns = [
      turn(1, [...nodes.items, ...file.items]),
      turn(2, [toolItem('node-edit', 'node_edit', { operation: 'replace_outline', node_id: 'node-a' })]),
      turn(3, nodeAfterEdit.items),
      turn(4, [toolItem('undo', 'outline_undo_stack', { action: 'undo' })]),
    ];

    const plan = await planContextCompaction({ turns, readContext: store.read });

    expect(plan?.restoredState.activeObservations).toEqual([{
      key: 'file:/workspace/notes.md',
      tool: 'file_read',
      subject: '/workspace/notes.md',
      outputRef: file.outputRef,
      projectionRef: file.projectionRef,
    }]);
  });

  test('does not invalidate Node observations for previews or failed mutations', async () => {
    const store = createPayloadStore();
    const node = observation(
      store,
      'node-read',
      'node_read',
      { node_id: 'node-a' },
      'Node snapshot A',
    );
    const turns = [
      turn(1, node.items),
      turn(2, [toolItem(
        'node-preview',
        'node_edit',
        { operation: 'replace_outline', node_id: 'node-a', preview_only: true },
      )]),
      turn(3, [toolItem(
        'node-failed',
        'node_delete',
        { node_id: 'node-a' },
        { success: false, status: 'failed' },
      )]),
      turn(4, [toolItem('undo-list', 'outline_undo_stack', { action: 'list' })]),
    ];

    const plan = await planContextCompaction({ turns, readContext: store.read });

    expect(plan?.restoredState.activeObservations).toEqual([{
      key: 'node:node-a',
      tool: 'node_read',
      subject: 'node-a',
      outputRef: node.outputRef,
      projectionRef: node.projectionRef,
    }]);
  });

  test('uses structured evidence summaries to invalidate the affected file observation', async () => {
    const store = createPayloadStore();
    const edited = observation(
      store,
      'edited-file-read',
      'file_read',
      { file_path: '/workspace/edited.md' },
      'Edited file snapshot',
    );
    const retained = observation(
      store,
      'retained-file-read',
      'file_read',
      { file_path: '/workspace/retained.md' },
      'Retained file snapshot',
    );
    const degradedMutation = {
      ...toolItem('degraded-file-edit', 'file_edit', { file_path: '/workspace/edited.md' }),
      modelCall: {
        disposition: 'evidenceOnly' as const,
        identity: { namespace: null, name: 'file_edit' },
        providerName: 'file_edit',
        redactedArgumentsSummary: { file_path: '/workspace/edited.md' },
        reason: 'schemaIncompatible' as const,
        correction: 'Inspect current file state before editing again.',
      },
    } satisfies ThreadItem;

    const plan = await planContextCompaction({
      turns: [turn(1, [...edited.items, ...retained.items]), turn(2, [degradedMutation])],
      readContext: store.read,
    });

    expect(plan?.restoredState.activeObservations).toEqual([{
      key: 'file:/workspace/retained.md',
      tool: 'file_read',
      subject: '/workspace/retained.md',
      outputRef: retained.outputRef,
      projectionRef: retained.projectionRef,
    }]);
  });

  test('conservatively clears observations when successful mutation arguments are unavailable', async () => {
    const store = createPayloadStore();
    const node = observation(
      store,
      'stale-node-read',
      'node_read',
      { node_id: 'node-a' },
      'Stale node snapshot',
    );
    const file = observation(
      store,
      'stale-file-read',
      'file_read',
      { file_path: '/workspace/stale.md' },
      'Stale file snapshot',
    );
    const nodeArgumentsRef = store.put({
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { operation: 'replace_outline', node_id: 'node-a' },
    });
    const fileArgumentsRef = store.put({
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { file_path: '/workspace/stale.md', content: 'updated' },
    });
    store.remove(nodeArgumentsRef);
    store.remove(fileArgumentsRef);
    const nodeMutation = payloadBackedToolItem('missing-node-arguments', 'node_edit', nodeArgumentsRef);
    const fileMutation = payloadBackedToolItem('missing-file-arguments', 'file_write', fileArgumentsRef);

    const plan = await planContextCompaction({
      turns: [
        turn(1, [...node.items, ...file.items]),
        turn(2, [nodeMutation]),
        turn(3, [fileMutation]),
      ],
      readContext: store.read,
    });

    expect(plan?.restoredState.activeObservations).toEqual([]);
  });

  test('reads payload-backed canonical arguments once per Item during compaction', async () => {
    const store = createPayloadStore();
    const file = observation(
      store,
      'payload-file-read',
      'file_read',
      { file_path: '/workspace/payload.md' },
      'Payload-backed file snapshot',
    );
    const argumentsRef = store.put({
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { file_path: '/workspace/payload.md' },
    });
    const payloadItem = {
      ...file.items[0]!,
      modelCall: {
        ...replayableModelCall('file_read', {}),
        arguments: { storage: 'payload' as const, ref: argumentsRef },
      },
    } satisfies ThreadItem;
    let argumentReads = 0;

    const plan = await planContextCompaction({
      turns: [turn(1, [payloadItem, file.items[1]!])],
      readContext: async (ref) => {
        if (ref.id === argumentsRef.id) argumentReads += 1;
        return store.read(ref);
      },
    });

    expect(plan?.restoredState.activeObservations).toHaveLength(1);
    expect(argumentReads).toBe(1);
  });

  test('does not read payload-backed arguments for tools unrelated to observations', async () => {
    const store = createPayloadStore();
    const argumentsRef = store.put({
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { query: 'unrelated tool arguments' },
    });
    const unrelated = payloadBackedToolItem('unrelated-tool', 'unrelated_tool', argumentsRef);
    let argumentReads = 0;

    const plan = await planContextCompaction({
      turns: [turn(1, [unrelated])],
      readContext: async (ref) => {
        if (ref.id === argumentsRef.id) argumentReads += 1;
        return store.read(ref);
      },
    });

    expect(plan).not.toBeNull();
    expect(argumentReads).toBe(0);
  });

  test('retains complete typed output identities for active observation checkpoints', async () => {
    const store = createPayloadStore();
    const digest = createHash('sha256').update('shared-output').digest('hex');
    const plainRef: ThreadItemOutputReference = {
      id: digest,
      mimeType: 'text/plain',
      byteLength: 12,
      summary: 'Plain identity',
    };
    const jsonRef: ThreadItemOutputReference = {
      id: digest,
      mimeType: 'application/json',
      byteLength: 12,
      summary: 'JSON identity',
    };
    const plain = observation(
      store,
      'plain-observation',
      'file_read',
      { file_path: '/workspace/plain.txt' },
      'shared bytes',
      plainRef,
    );
    const json = observation(
      store,
      'json-observation',
      'file_read',
      { file_path: '/workspace/data.json' },
      'shared bytes',
      jsonRef,
    );

    const plan = await planContextCompaction({
      turns: [turn(1, [...plain.items, ...json.items])],
      readContext: store.read,
    });

    expect(plan?.outputRefs).toHaveLength(2);
    expect(plan?.outputRefs).toEqual(expect.arrayContaining([plainRef, jsonRef]));
  });

  test('skips an unreadable frozen projection without aborting compaction', async () => {
    const store = createPayloadStore();
    const observed = observation(
      store,
      'unreadable-observation',
      'file_read',
      { file_path: '/workspace/unreadable.txt' },
      'Unreadable snapshot',
    );

    const plan = await planContextCompaction({
      turns: [turn(1, observed.items)],
      readContext: async (ref) => {
        if (ref.id === observed.projectionRef.id) throw new Error('payload read failed');
        return store.read(ref);
      },
    });

    expect(plan).not.toBeNull();
    expect(plan?.restoredState.activeObservations).toEqual([]);
    expect(plan?.restoredState.degradations).toContainEqual(expect.objectContaining({
      code: 'payloadUnavailable',
      source: 'toolOutputProjection',
    }));
  });

  test('keeps conflicting frozen projections unavailable after later duplicates', async () => {
    const store = createPayloadStore();
    const observed = observation(
      store,
      'conflicting-observation',
      'file_read',
      { file_path: '/workspace/conflicting.txt' },
      'First frozen snapshot',
    );
    const conflictingRef = store.put({
      schemaVersion: 1,
      kind: 'toolOutputProjection',
      outputRef: observed.outputRef,
      projection: { type: 'inline', text: 'Second frozen snapshot' },
    });
    const firstEvidence = observed.items[1];
    if (!firstEvidence || firstEvidence.type !== 'contextEvidence') {
      throw new Error('Expected the observation projection evidence.');
    }
    const conflictingEvidence: ContextEvidenceThreadItem = {
      ...firstEvidence,
      id: 'second-conflicting-projection',
      provenance: provenance('second-conflicting-projection'),
      payloadRef: conflictingRef,
    };
    const laterDuplicate: ContextEvidenceThreadItem = {
      ...firstEvidence,
      id: 'later-matching-projection',
      provenance: provenance('later-matching-projection'),
    };

    const plan = await planContextCompaction({
      turns: [turn(1, [...observed.items, conflictingEvidence, laterDuplicate])],
      readContext: store.read,
    });

    expect(plan).not.toBeNull();
    expect(plan?.restoredState.activeObservations).toEqual([]);
    expect(plan?.restoredState.degradations).toContainEqual(expect.objectContaining({
      code: 'projectionConflict',
      source: 'toolOutputProjection',
    }));
  });

  test('accepts a valid frozen projection after context reset clears an earlier conflict', async () => {
    const store = createPayloadStore();
    const observed = observation(
      store,
      'reset-conflicting-observation',
      'file_read',
      { file_path: '/workspace/reset-conflicting.txt' },
      'First frozen snapshot',
    );
    const firstEvidence = observed.items[1];
    if (!firstEvidence || firstEvidence.type !== 'contextEvidence') {
      throw new Error('Expected the observation projection evidence.');
    }
    const conflictingRef = store.put({
      schemaVersion: 1,
      kind: 'toolOutputProjection',
      outputRef: observed.outputRef,
      projection: { type: 'inline', text: 'Conflicting frozen snapshot' },
    });
    const conflict: ContextEvidenceThreadItem = {
      ...firstEvidence,
      id: 'reset-conflicting-projection',
      provenance: provenance('reset-conflicting-projection'),
      payloadRef: conflictingRef,
    };
    const beforeReset = turn(1, [...observed.items, conflict]);
    const reset: ThreadItem = {
      type: 'contextReset',
      id: 'projection-reset',
      provenance: provenance('projection-reset'),
      clearedThrough: { turnId: beforeReset.id, itemId: conflict.id },
    };
    const recoveredTool: ThreadItem = {
      ...observed.items[0]!,
      id: 'recovered-observation',
      provenance: provenance('recovered-observation'),
    };
    const recoveredProjection: ContextEvidenceThreadItem = {
      ...firstEvidence,
      id: 'recovered-projection',
      provenance: provenance('recovered-projection'),
    };

    const plan = await planContextCompaction({
      turns: [beforeReset, turn(2, [reset, recoveredTool, recoveredProjection])],
      readContext: store.read,
    });

    expect(plan?.restoredState.activeObservations).toEqual([expect.objectContaining({
      key: 'file:/workspace/reset-conflicting.txt',
      projectionRef: observed.projectionRef,
    })]);
    expect(plan?.restoredState.degradations).toEqual([]);
  });

  test('records unavailable compaction, Skill, and additional-context payloads without aborting', async () => {
    const store = createPayloadStore();
    const skillItem = contextEvidence(store, skillInvocation('7', 'Unavailable instructions'), 'missing-skill');
    const additionalItem = contextEvidence(store, {
      schemaVersion: 1,
      kind: 'additionalContext',
      turnEntries: [],
      threadState: [{
        key: 'policy',
        source: 'test',
        authority: 'application',
        purpose: 'instruction',
        text: 'Unavailable policy',
      }],
    }, 'missing-additional-context');
    store.remove(skillItem.payloadRef);
    store.remove(additionalItem.payloadRef);
    const summaryRef = store.put({
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'deterministic',
      text: 'Prior summary',
    });
    const restoredStateRef = store.put({
      schemaVersion: 1,
      kind: 'compactionRestoredState',
      skillCatalogHash: null,
      announcedSkills: [],
      activeSkills: [],
      roleCatalogHash: null,
      announcedRoles: [],
      userViewBaselineRef: null,
      additionalContextBaselineRef: null,
      activeObservations: [],
      degradations: [],
    });
    store.remove(restoredStateRef);
    const priorTurn = turn(1, [userMessage('Prior request', 'prior-request')]);
    const compaction: ThreadItem = {
      type: 'contextCompaction',
      id: 'missing-restored-state',
      provenance: provenance('missing-restored-state'),
      trigger: 'manual',
      coveredFrom: { turnId: priorTurn.id, itemId: 'prior-request' },
      coveredThrough: { turnId: priorTurn.id, itemId: 'prior-request' },
      preservedFrom: null,
      summaryRef,
      restoredStateRef,
      instructionsRef: null,
      contextRefs: [summaryRef, restoredStateRef],
      resourceRefs: [],
      outputRefs: [],
    };

    const plan = await planContextCompaction({
      turns: [
        priorTurn,
        turn(2, [compaction, skillItem, additionalItem, userMessage('Continue', 'continue')]),
      ],
      readContext: store.read,
    });

    expect(plan).not.toBeNull();
    expect(plan?.restoredState.degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'payloadUnavailable', source: 'compactionRestoredState' }),
      expect.objectContaining({ code: 'payloadUnavailable', source: 'skillInvocation' }),
      expect.objectContaining({ code: 'payloadUnavailable', source: 'additionalContext' }),
    ]));
  });

  test('restores the latest active Skill from the effective preserved tail', async () => {
    const store = createPayloadStore();
    const catalog = {
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: 'a'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'alpha',
        displayName: 'Alpha',
        source: 'project' as const,
        identity: 'project:alpha',
        contentHash: '1'.repeat(64),
        description: 'Alpha instructions.',
      }],
    };
    const oldSkill = skillInvocation('1', 'Old instructions');
    const newSkill = skillInvocation('2', 'New instructions');
    const catalogItem = contextEvidence(store, catalog, 'skill-catalog');
    const oldItem = contextEvidence(store, oldSkill, 'old-skill');
    const newItem = contextEvidence(store, newSkill, 'new-skill');
    const first = turn(10, [catalogItem, oldItem]);
    const restoredStateRef = store.put({
      schemaVersion: 1,
      kind: 'compactionRestoredState',
      skillCatalogHash: catalog.catalogHash,
      announcedSkills: [{ name: 'alpha', identity: 'project:alpha', contentHash: '1'.repeat(64) }],
      activeSkills: [{
        name: 'alpha',
        identity: 'project:alpha',
        contentHash: oldSkill.contentHash,
        payloadRef: oldItem.payloadRef,
      }],
      roleCatalogHash: null,
      announcedRoles: [],
      userViewBaselineRef: null,
      additionalContextBaselineRef: null,
      activeObservations: [],
      degradations: [],
    });
    const summaryRef = store.put({
      schemaVersion: 1,
      kind: 'compactionSummary',
      source: 'deterministic',
      text: 'Earlier context.',
    });
    const preservedTurnId = uuidV7(1_720_000_001_100);
    const priorCompaction: ThreadItem = {
      type: 'contextCompaction',
      id: 'prior-compaction',
      provenance: provenance('prior-compaction'),
      trigger: 'automaticPreflight',
      coveredFrom: { turnId: first.id, itemId: catalogItem.id },
      coveredThrough: { turnId: first.id, itemId: oldItem.id },
      preservedFrom: { turnId: preservedTurnId, itemId: newItem.id },
      summaryRef,
      restoredStateRef,
      instructionsRef: null,
      contextRefs: [oldItem.payloadRef],
      resourceRefs: [],
      outputRefs: [],
    };
    const preserved = turn(11, [newItem, priorCompaction], preservedTurnId);

    const plan = await planContextCompaction({ turns: [first, preserved], readContext: store.read });

    expect(plan?.restoredState.activeSkills).toEqual([{
      name: 'alpha',
      identity: 'project:alpha',
      contentHash: newSkill.contentHash,
      payloadRef: newItem.payloadRef,
    }]);
  });

  test('summarizes complete inherited parent Turns instead of only the evidence label', async () => {
    const store = createPayloadStore();
    const inherited = inheritedEvidence(store, [turn(1, [
      userMessage('PARENT REQUIREMENT MUST SURVIVE CHILD COMPACTION', 'parent-user'),
      {
        type: 'agentMessage',
        id: 'parent-assistant',
        provenance: provenance('parent-assistant'),
        text: 'Parent analysis with the decisive constraint.',
        phase: 'final_answer',
        memoryCitation: null,
      },
    ])], 'inherited-parent');

    const plan = await planContextCompaction({
      turns: [turn(2, [inherited, userMessage('Child task', 'child-user')])],
      readContext: store.read,
    });

    expect(plan?.summary.text).toContain('Context: Inherited context');
    expect(plan?.summary.text).toContain('PARENT REQUIREMENT MUST SURVIVE CHILD COMPACTION');
    expect(plan?.summary.text).toContain('Parent analysis with the decisive constraint.');
  });

  test('bounds deterministic summaries by retaining the newest complete Turn suffix', async () => {
    const store = createPayloadStore();
    const turns = Array.from({ length: 30 }, (_, index) => turn(index, [
      userMessage(`MESSAGE-${String(index).padStart(2, '0')}:${'x'.repeat(2_000)}`, `message-${index}`),
    ]));

    const plan = await planContextCompaction({ turns, readContext: store.read });

    expect(plan?.summary.text.length).toBeLessThanOrEqual(24_000);
    expect(plan?.summary.text).toContain('[Earlier Turns omitted at the deterministic summary limit.]');
    expect(plan?.summary.text).not.toContain('MESSAGE-00');
    expect(plan?.summary.text).not.toContain('MESSAGE-15');
    expect(plan?.summary.text).toContain('MESSAGE-29');
  });

  test('marks an oversized newest Turn while retaining both ends of its content', async () => {
    const store = createPayloadStore();
    const oversized = `LATEST-START:${'x'.repeat(30_000)}:LATEST-END`;

    const plan = await planContextCompaction({
      turns: [turn(1, [userMessage(oversized, 'oversized-message')])],
      readContext: store.read,
    });

    expect(plan?.summary.text.length).toBe(24_000);
    expect(plan?.summary.text).toContain('LATEST-START');
    expect(plan?.summary.text).toContain('[Turn content truncated at the deterministic summary limit.]');
    expect(plan?.summary.text).toContain('LATEST-END');
  });

  test('checkpoints inherited catalogs, view, Thread state, Skills, and observations across repeated compaction', async () => {
    const store = createPayloadStore();
    const skillCatalog = {
      schemaVersion: 1 as const,
      kind: 'skillCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: 'a'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'alpha',
        displayName: 'Alpha',
        source: 'project' as const,
        identity: 'project:alpha',
        contentHash: '1'.repeat(64),
        description: 'Inherited Skill description.',
      }],
    };
    const activeSkill = skillInvocation('1', 'Inherited Skill instructions.');
    const roleCatalog = {
      schemaVersion: 1 as const,
      kind: 'roleCatalog' as const,
      mode: 'baseline' as const,
      previousCatalogHash: null,
      catalogHash: 'b'.repeat(64),
      entries: [{
        change: 'available' as const,
        name: 'worker',
        displayName: 'Worker',
        source: 'built-in' as const,
        identity: 'built-in:worker',
        contentHash: '2'.repeat(64),
        description: 'Inherited Role description.',
      }],
    };
    const userView = {
      schemaVersion: 1 as const,
      kind: 'userView' as const,
      mode: 'interactive' as const,
      activePanelId: 'panel-1',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      focusedNode: { nodeId: 'node-a', title: 'Inherited node', panelId: 'panel-1', surface: 'row' },
      selectedNodes: [],
      referencedNodes: [],
      panels: [],
      truncated: false,
    };
    const additionalContext = {
      schemaVersion: 1 as const,
      kind: 'additionalContext' as const,
      turnEntries: [{
        key: 'request-event',
        source: 'main',
        authority: 'application' as const,
        purpose: 'instruction' as const,
        text: 'This event must not be replayed by compaction.',
      }],
      threadState: [{
        key: 'memory:policy',
        source: 'extension:memory',
        authority: 'application' as const,
        purpose: 'instruction' as const,
        text: 'Inherited Thread policy.',
      }],
    };
    const observed = observation(
      store,
      'inherited-file-read',
      'file_read',
      { file_path: '/workspace/inherited.md' },
      'Inherited file snapshot',
    );
    const nestedTurn = turn(20, [
      contextEvidence(store, skillCatalog, 'inherited-skill-catalog'),
      contextEvidence(store, activeSkill, 'inherited-active-skill'),
      contextEvidence(store, roleCatalog, 'inherited-role-catalog'),
      contextEvidence(store, userView, 'inherited-user-view'),
      contextEvidence(store, additionalContext, 'inherited-additional-context'),
      ...observed.items,
    ]);
    const inherited = inheritedEvidence(store, [nestedTurn], 'inherited-context');
    const outer = turn(21, [inherited, userMessage('Child request', 'child-user')]);

    const firstPlan = await planContextCompaction({
      turns: [outer],
      preserveFrom: { turnId: outer.id, itemId: 'child-user' },
      readContext: store.read,
    });
    expect(firstPlan?.restoredState).toMatchObject({
      skillCatalogHash: skillCatalog.catalogHash,
      roleCatalogHash: roleCatalog.catalogHash,
      userViewBaselineRef: contextEvidenceRef(nestedTurn, 'userView'),
      additionalContextBaselineRef: contextEvidenceRef(nestedTurn, 'additionalContext'),
      activeSkills: [{
        name: 'alpha',
        contentHash: activeSkill.contentHash,
        payloadRef: contextEvidenceRef(nestedTurn, 'skillInvocation'),
      }],
      activeObservations: [{
        key: 'file:/workspace/inherited.md',
        outputRef: observed.outputRef,
        projectionRef: observed.projectionRef,
      }],
    });
    expect(firstPlan?.restoredState.announcedSkills).toEqual([{
      name: 'alpha',
      identity: 'project:alpha',
      contentHash: '1'.repeat(64),
    }]);
    expect(firstPlan?.restoredState.announcedRoles).toEqual([{
      name: 'worker',
      identity: 'built-in:worker',
      contentHash: '2'.repeat(64),
    }]);
    if (!firstPlan) throw new Error('Expected inherited compaction plan.');
    expect(firstPlan.coveredFrom).toEqual({ turnId: outer.id, itemId: inherited.id });
    expect(firstPlan.coveredThrough).toEqual({ turnId: outer.id, itemId: inherited.id });
    expect(firstPlan.preservedFrom).toEqual({ turnId: outer.id, itemId: 'child-user' });

    const summaryRef = store.put(firstPlan.summary);
    const restoredStateRef = store.put(firstPlan.restoredState);
    const firstCompaction: ThreadItem = {
      type: 'contextCompaction',
      id: 'first-outer-compaction',
      provenance: provenance('first-outer-compaction'),
      trigger: 'manual',
      coveredFrom: firstPlan.coveredFrom,
      coveredThrough: firstPlan.coveredThrough,
      preservedFrom: firstPlan.preservedFrom,
      summaryRef,
      restoredStateRef,
      instructionsRef: null,
      contextRefs: firstPlan.contextRefs,
      resourceRefs: [],
      outputRefs: firstPlan.outputRefs,
    };
    const afterCompaction = turn(22, [firstCompaction, userMessage('Compact again', 'after-compact-user')]);
    const secondPlan = await planContextCompaction({
      turns: [outer, afterCompaction],
      readContext: store.read,
    });

    expect(secondPlan?.restoredState.activeObservations).toEqual(firstPlan.restoredState.activeObservations);
    expect(secondPlan?.restoredState.activeSkills).toEqual(firstPlan.restoredState.activeSkills);
    expect(secondPlan?.restoredState.userViewBaselineRef).toEqual(firstPlan.restoredState.userViewBaselineRef);
    expect(secondPlan?.restoredState.additionalContextBaselineRef)
      .toEqual(firstPlan.restoredState.additionalContextBaselineRef);
  });
});

function contextEvidence(
  store: ReturnType<typeof createPayloadStore>,
  payload: Extract<ThreadContextPayload, {
    kind: 'skillCatalog' | 'skillInvocation' | 'roleCatalog' | 'userView' | 'additionalContext';
  }>,
  id: string,
): ContextEvidenceThreadItem {
  const payloadRef = store.put(payload);
  return {
    type: 'contextEvidence',
    id,
    provenance: provenance(id),
    kind: payload.kind,
    payloadRef,
    summary: payload.kind,
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [],
  };
}

function inheritedEvidence(
  store: ReturnType<typeof createPayloadStore>,
  turns: readonly Turn[],
  id: string,
): ContextEvidenceThreadItem {
  const lastTurn = turns.at(-1)!;
  const payloadRef = store.put({
    schemaVersion: 1,
    kind: 'inheritedContext',
    sourceThreadId: THREAD_ID,
    coveredThrough: { turnId: lastTurn.id, itemId: lastTurn.items.at(-1)!.id },
    requestedTurns: 'all',
    turns,
  });
  return {
    type: 'contextEvidence',
    id,
    provenance: provenance(id),
    kind: 'inheritedContext',
    payloadRef,
    summary: 'Inherited context',
    contextRefs: turns.flatMap((turn) => turn.items.flatMap((item) => (
      item.type === 'contextEvidence' ? [item.payloadRef, ...item.contextRefs] : []
    ))),
    resourceRefs: [],
    outputRefs: turns.flatMap((turn) => turn.items.flatMap((item) => (
      'outputRef' in item && item.outputRef ? [item.outputRef] : item.type === 'contextEvidence' ? item.outputRefs : []
    ))),
  };
}

function contextEvidenceRef(
  turn: Turn,
  kind: ContextEvidenceThreadItem['kind'],
): ThreadContextPayloadReference {
  const item = turn.items.find((candidate) => candidate.type === 'contextEvidence' && candidate.kind === kind);
  if (!item || item.type !== 'contextEvidence') throw new Error(`Missing ${kind} evidence.`);
  return item.payloadRef;
}

function userMessage(text: string, id: string): ThreadItem {
  return {
    type: 'userMessage',
    id,
    provenance: provenance(id),
    clientId: null,
    acceptedAt: 1,
    content: [{ type: 'text', text }],
  };
}

function skillInvocation(seed: string, instructions: string) {
  return {
    schemaVersion: 1 as const,
    kind: 'skillInvocation' as const,
    name: 'alpha',
    displayName: 'Alpha',
    source: 'project' as const,
    identity: 'project:alpha',
    resourceRoot: '/workspace/.agents/skills/alpha',
    contentHash: seed.repeat(64).slice(0, 64),
    instructions,
    arguments: '',
    execution: 'inline' as const,
    invocationSource: 'model' as const,
    constraints: { allowedTools: [], model: null, effort: null },
    invokedAt: 1,
  };
}

function observation(
  store: ReturnType<typeof createPayloadStore>,
  id: string,
  tool: 'file_read' | 'node_read',
  args: JsonValue,
  text: string,
  outputRefOverride?: ThreadItemOutputReference,
): {
  items: readonly ThreadItem[];
  outputRef: ThreadItemOutputReference;
  projectionRef: ThreadContextPayloadReference;
} {
  const outputRef = outputRefOverride ?? outputReference(id, text);
  const projectionRef = store.put({
    schemaVersion: 1,
    kind: 'toolOutputProjection',
    outputRef,
    projection: { type: 'inline', text },
  });
  const evidence: ContextEvidenceThreadItem = {
    type: 'contextEvidence',
    id: `${id}-projection`,
    provenance: provenance(`${id}-projection`),
    kind: 'toolOutputProjection',
    payloadRef: projectionRef,
    summary: `Frozen ${tool} output`,
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [outputRef],
  };
  return {
    items: [toolItem(id, tool, args, { outputRef }), evidence],
    outputRef,
    projectionRef,
  };
}

function toolItem(
  id: string,
  tool: string,
  argumentsValue: JsonValue,
  options: {
    outputRef?: ThreadItemOutputReference;
    success?: boolean;
    status?: 'completed' | 'failed';
  } = {},
): ThreadItem {
  return {
    type: 'dynamicToolCall',
    id,
    provenance: provenance(id),
    namespace: null,
    tool,
    arguments: argumentsValue,
    status: options.status ?? 'completed',
    outputRef: options.outputRef ?? null,
    contentItems: [{ type: 'text', text: `${tool} result` }],
    success: options.success ?? true,
    durationMs: 1,
    modelCall: replayableModelCall(tool, argumentsValue),
  };
}

function payloadBackedToolItem(
  id: string,
  tool: string,
  argumentsRef: ThreadContextPayloadReference,
): ThreadItem {
  return {
    ...toolItem(id, tool, {}),
    modelCall: {
      ...replayableModelCall(tool, {}),
      arguments: { storage: 'payload', ref: argumentsRef },
    },
  };
}

function turn(index: number, items: readonly ThreadItem[], id?: ReturnType<typeof uuidV7>): Turn {
  const startedAt = 1_720_000_000_000 + index * 100;
  const turnId = id ?? uuidV7(startedAt);
  return {
    id: turnId,
    items,
    itemsView: 'full',
    provenance: {
      originThreadId: THREAD_ID,
      originTurnId: turnId,
      trigger: { kind: 'user' },
    },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt,
    completedAt: startedAt + 50,
    durationMs: 50,
  };
}

function createPayloadStore() {
  const payloads = new Map<string, ThreadContextPayload>();
  return {
    put(payload: ThreadContextPayload): ThreadContextPayloadReference {
      const encoded = JSON.stringify(payload);
      const ref: ThreadContextPayloadReference = {
        id: createHash('sha256').update(encoded).digest('hex'),
        mimeType: 'application/vnd.tenon.agent-context+json',
        byteLength: Buffer.byteLength(encoded),
        schemaVersion: 1,
        kind: payload.kind,
      };
      payloads.set(ref.id, payload);
      return ref;
    },
    remove(ref: ThreadContextPayloadReference): void {
      payloads.delete(ref.id);
    },
    read: async (ref: ThreadContextPayloadReference) => payloads.get(ref.id) ?? null,
  };
}

function outputReference(id: string, text: string): ThreadItemOutputReference {
  return {
    id: createHash('sha256').update(id).digest('hex'),
    mimeType: 'text/plain',
    byteLength: Buffer.byteLength(text),
    summary: text,
  };
}

function provenance(itemId: string) {
  return {
    originThreadId: THREAD_ID,
    originTurnId: uuidV7(1_720_000_000_001),
    originItemId: itemId,
  };
}

const THREAD_ID = uuidV7(1_720_000_000_000);
