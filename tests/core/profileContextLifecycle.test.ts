import { planAdditionalContextState } from '../../src/main/agent/context/AdditionalContextState';
import { additionalContextPayload } from '../../src/main/agent/context/evidenceAdmission';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { encodeThreadContextPayload } from '../../src/core/agent/codec';
import type { AdditionalContext, Thread, ThreadContextPayload, ThreadContextPayloadReference, ThreadItem, Turn } from '../../src/core/agent/protocol';
import type { ProfileEvidence, ProfileLearningChange } from '../../src/core/agent/profileFiles';
import { defaultEffectiveThreadConfiguration } from '../../src/main/agent/AgentConfigurationLoader';
import { ProfileFileStore } from '../../src/main/agent/profile/ProfileFileStore';
import { captureProfileTurn, captureReplayedProfileTurn, profileStateForTurn } from '../../src/main/agent/profile/ProfileContext';
import { admitContextEvidence, contextEvidenceItem } from '../../src/main/agent/context/evidenceAdmission';
import { CanonicalContextProjector } from '../../src/main/agent/context/ContextProjector';
import { planContextCompaction } from '../../src/main/agent/context/ContextCompaction';
import { contextPayloadDependencies } from '../../src/main/agent/context/contextDependencies';
import { composeStablePrompt } from '../../src/main/agent/context/stablePrompt';
import { providerCacheAffinity } from '../../src/main/agent/context/ProviderCache';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { uuidV7 } from '../../src/main/agent/uuid';

const model = { api: 'openai-completions', id: 'fixture', provider: 'fixture', input: ['text'], reasoning: false } as Model<Api>;
const thread: Thread = { id: uuidV7(), sessionId: uuidV7(), parentThreadId: null, forkedFromId: null, name: null, preview: '',
  ephemeral: false, source: 'app', threadSource: 'user', modelProvider: 'fixture', configurationSource: { kind: 'user' },
  createdAt: 1, updatedAt: 1, status: { type: 'idle' }, historyMode: 'paginated' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profile-context-'));
  const store = new ProfileFileStore(root, new Database(':memory:') as unknown as SqliteDatabase, () => 123);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const payloads = new Map<string, ThreadContextPayload>();
  const write = (payload: ThreadContextPayload): ThreadContextPayloadReference => {
    const encoded = encodeThreadContextPayload(payload);
    const ref = { id: createHash('sha256').update(encoded).digest('hex'), kind: payload.kind, schemaVersion: 1 as const,
      mimeType: 'application/vnd.tenon.agent-context+json' as const, byteLength: Buffer.byteLength(encoded) };
    payloads.set(ref.id, payload);
    return ref;
  };
  const read = async (ref: ThreadContextPayloadReference) => payloads.get(ref.id) ?? null;
  const resources = { readContext: read, readInternalText: async () => null, readOutput: async () => null, readResource: async () => null,
    resolveResourceObservationPath: async () => null, resolveImageArtifactPath: async () => null };
  const project = (turns: readonly Turn[]) => new CanonicalContextProjector(model, resources).projectTurns(turns);
  const state = (learned = true) => {
    const id = uuidV7();
    captureProfileTurn(store, thread.id, id, 'default', learned);
    return profileStateForTurn(store, id, learned);
  };
  const input = async (state: AdditionalContext, initial: readonly ThreadItem[] = []): Promise<Turn> => {
    const id = uuidV7();
    const content = [{ type: 'text' as const, text: 'Continue the report.' }];
    const admitted = await admitContextEvidence({ thread, turnId: id, acceptedAt: 123, content,
      extensionContext: [{ extensionId: 'memory', additionalContext: state, applicationInstructions: true }],
      includeHostContext: true, projection: null, createItemId: uuidV7, writeContext: async (payload) => write(payload),
      writeResource: async () => { throw new Error('Unexpected resource'); },
    });
    const userId = uuidV7(), agentId = uuidV7();
    return turn(id, [...initial, ...admitted.items,
      { type: 'userMessage', id: userId, clientId: null, author: { kind: 'reader' }, acceptedAt: 123, content, provenance: provenance(id, userId) },
      { type: 'agentMessage', id: agentId, text: 'Done.', phase: 'final_answer', memoryCitation: null, provenance: provenance(id, agentId) },
    ]);
  };
  const compact = async (turns: readonly Turn[], preserveFrom?: { turnId: string; itemId: string }) => {
    const plan = (await planContextCompaction({ turns, preserveFrom, readContext: read }))!;
    const turnId = uuidV7(), id = uuidV7();
    return { plan, turn: turn(turnId, [{ type: 'contextCompaction', id, provenance: provenance(turnId, id), trigger: 'manual',
      coveredFrom: plan.coveredFrom, coveredThrough: plan.coveredThrough, preservedFrom: plan.preservedFrom,
      summaryRef: write(plan.summary), restoredStateRef: write(plan.restoredState), instructionsRef: null,
      contextRefs: plan.contextRefs, internalTextRefs: [], resourceRefs: [], outputRefs: plan.outputRefs }]) };
  };
  return { store, payloads, write, read, project, state, input, compact };
}
const evidence = (id: string): ProfileEvidence => ({ threadId: thread.id, turnId: `turn:${id}`, originItemId: `item:${id}`,
  sourceDate: '2026-09-12', observedAt: 123, readerText: true });
const change = (id: string, text = 'CONCLUSIONS FIRST', key = 'reports'): ProfileLearningChange => ({ action: 'upsert', key,
  scope: 'Research reports', text, originItemIds: [`item:${id}`], rationale: { futureUse: 'Reports', novelty: 'Independent preference' } });
function learn(store: ProfileFileStore, id: string, text?: string, key?: string) {
  store.applyLearning(`publication:${id}`, store.inspect('user').revision, [change(id, text, key)], [evidence(id)]);
}
function text(message: Message): string { return JSON.stringify(message.content); }
function turn(id: string, items: readonly ThreadItem[]): Turn {
  return { id, items, itemsView: 'full', provenance: { originThreadId: thread.id, originTurnId: id, trigger: { kind: 'user' } },
    status: 'completed', error: null, startedAt: 123, completedAt: 124, durationMs: 1,
    execution: { modelProvider: 'fixture', model: 'fixture', reasoningEffort: 'medium', diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null } } };
}
function provenance(turnId: string, itemId: string) { return { originThreadId: thread.id, originTurnId: turnId, originItemId: itemId }; }

describe('Profile context through canonical Thread state', () => {
  test('confirmation metadata changes neither projected input nor stable prompt or cache affinity', async () => {
    const f = fixture();
    learn(f.store, 'a');
    const state = f.state();
    const first = await f.input(state);
    const prefix = await f.project([first]);
    const stable = composeStablePrompt({ thread, configuration: defaultEffectiveThreadConfiguration() });
    const revision = f.store.inspect('user').revision;
    learn(f.store, 'b');
    expect(f.store.inspect('user').revision).toBeGreaterThan(revision);
    expect(f.state()).toEqual(state);
    const second = await f.input(f.state());
    const projected = await f.project([first, second]);
    expect(projected.slice(0, prefix.length)).toEqual(prefix);
    expect(text(projected[prefix.length])).not.toContain('CONCLUSIONS FIRST');
    expect(text(projected[prefix.length])).not.toContain('Profile sources');
    expect(composeStablePrompt({ thread, configuration: defaultEffectiveThreadConfiguration() })).toEqual(stable);
    expect(stable.text).not.toContain('CONCLUSIONS FIRST');
    expect(providerCacheAffinity(thread.id, [first, second])).toBe(providerCacheAffinity(thread.id, [first]));
  });

  test('appends one changed entry and a named withdrawal without rewriting earlier messages', async () => {
    const f = fixture();
    f.store.edit({ kind: 'style', expectedDigest: null, content: 'STABLE STYLE', author: 'manual' });
    learn(f.store, 'a');
    learn(f.store, 'other', 'INDEPENDENT PREFERENCE', 'other');
    const first = await f.input(f.state());
    const prefix = await f.project([first]);
    learn(f.store, 'b', 'EVIDENCE FIRST');
    const second = await f.input(f.state());
    const changed = await f.project([first, second]);
    expect(changed.slice(0, prefix.length)).toEqual(prefix);
    const delta = text(changed[prefix.length]);
    expect(delta).toContain('EVIDENCE FIRST');
    expect(delta).toContain('replaces its earlier value');
    expect(delta).not.toContain('STABLE STYLE');
    expect(delta).not.toContain('INDEPENDENT PREFERENCE');
    const current = f.store.inspect('user');
    f.store.edit({ kind: 'user', expectedDigest: current.savedDigest, content: current.content.replace(/\n## reports[\s\S]*?(?=\n## other)/, ''), author: 'manual' });
    const third = await f.input(f.state());
    const removed = await f.project([first, second, third]);
    expect(removed.slice(0, changed.length)).toEqual(changed);
    expect(text(removed[changed.length])).toContain('Profile preference reports');
    expect(text(removed[changed.length])).toContain('no longer active');
    expect(text(removed[changed.length])).not.toContain('INDEPENDENT PREFERENCE');
  });

  test('withdraws identity and style explicitly and omits learned entries when Memory is disabled', async () => {
    const f = fixture();
    f.store.edit({ kind: 'identity', expectedDigest: null, content: 'RESEARCH ROLE', author: 'manual' });
    f.store.edit({ kind: 'style', expectedDigest: null, content: 'STABLE STYLE', author: 'manual' });
    learn(f.store, 'a');
    const first = await f.input(f.state());
    for (const kind of ['identity', 'style'] as const) f.store.edit({ kind, expectedDigest: f.store.inspect(kind).savedDigest, content: '', author: 'manual' });
    const second = await f.input(f.state(false));
    const projected = await f.project([first, second]);
    const delta = text(projected[2]);
    expect(delta).toContain('Profile identity');
    expect(delta).toContain('Profile style');
    expect(delta).toContain('Stop applying');
    expect(delta).toContain('Profile preference reports');
    expect(delta).not.toContain('RESEARCH ROLE');
    expect(delta).not.toContain('CONCLUSIONS FIRST');
  });

  test('unselected entry updates do not perturb the selected context', () => {
    const f = fixture();
    for (let index = 0; index < 9; index++) learn(f.store, String(index), `PREFERENCE ${index} `.repeat(35), `preference-${index}`);
    const selected = f.state();
    expect(selected['profile_user_preference-8']).toBeUndefined();
    learn(f.store, 'late', 'NEW UNSELECTED CONTENT '.repeat(30), 'preference-8');
    expect(f.state()).toEqual(selected);
  });

  test('compaction restores the latest complete state and unchanged continuation adds no duplicate', async () => {
    const f = fixture();
    learn(f.store, 'a');
    const first = await f.input(f.state());
    learn(f.store, 'b', 'EVIDENCE FIRST');
    const second = await f.input(f.state());
    const checkpoint = await f.compact([first, second]);
    const stateRef = checkpoint.plan.restoredState.additionalContextBaselineRef!;
    expect(JSON.stringify(await f.read(stateRef))).toContain('EVIDENCE FIRST');
    expect(JSON.stringify(await f.read(stateRef))).not.toContain('CONCLUSIONS FIRST');
    const history = [first, second, checkpoint.turn];
    const before = await f.project(history);
    const third = await f.input(f.state());
    const after = await f.project([...history, third]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(text(after[before.length])).not.toContain('EVIDENCE FIRST');
    expect(providerCacheAffinity(thread.id, history)).toBe(providerCacheAffinity(thread.id, [first]));
  });

  test('compaction preserves a later update and deletion rather than restoring them too early', async () => {
    const f = fixture();
    learn(f.store, 'a');
    const first = await f.input(f.state());
    learn(f.store, 'b', 'EVIDENCE FIRST');
    const second = await f.input(f.state());
    const checkpoint = await f.compact([first, second], { turnId: second.id, itemId: second.items[0].id });
    expect(JSON.stringify(await f.read(checkpoint.plan.restoredState.additionalContextBaselineRef!))).toContain('CONCLUSIONS FIRST');
    f.store.edit({ kind: 'user', expectedDigest: f.store.inspect('user').savedDigest, content: '# User\n', author: 'manual' });
    const third = await f.input(f.state());
    const projected = await f.project([first, second, checkpoint.turn, third]);
    expect(projected.map(text).findIndex((value) => value.includes('CONCLUSIONS FIRST'))).toBeLessThan(projected.map(text).findIndex((value) => value.includes('EVIDENCE FIRST')));
    expect(text(projected.at(-2)!)).toContain('Profile preference reports');
    expect(text(projected.at(-2)!)).toContain('no longer active');
  });

  test('context clear starts a fresh baseline and missing checkpoint evidence heals at the next input', async () => {
    const f = fixture();
    learn(f.store, 'a');
    const first = await f.input(f.state());
    const checkpoint = await f.compact([first]);
    f.payloads.delete(checkpoint.plan.restoredState.additionalContextBaselineRef!.id);
    const degraded = await f.project([first, checkpoint.turn]);
    expect(degraded.map(text).join()).not.toContain('CONCLUSIONS FIRST');
    f.store.edit({ kind: 'style', expectedDigest: null, content: 'RECOVERED STYLE', author: 'manual' });
    const second = await f.input(f.state());
    const healed = await f.project([first, checkpoint.turn, second]);
    expect(text(healed.at(-2)!)).toContain('CONCLUSIONS FIRST');
    const resetTurnId = uuidV7(), resetId = uuidV7();
    const reset = turn(resetTurnId, [{ type: 'contextReset', id: resetId, provenance: provenance(resetTurnId, resetId),
      clearedThrough: { turnId: second.id, itemId: second.items.at(-1)!.id } }]);
    const third = await f.input(f.state());
    const cleared = await f.project([first, checkpoint.turn, second, reset, third]);
    expect(text(cleared[0])).toContain('CONCLUSIONS FIRST');
    expect(providerCacheAffinity(thread.id, [first, checkpoint.turn, second, reset, third])).not.toBe(providerCacheAffinity(thread.id, [first]));
  });

  test('inherited context retains its exact history and new root state appends the current replacement', async () => {
    const f = fixture();
    learn(f.store, 'a');
    const first = await f.input(f.state());
    const payload: ThreadContextPayload = { schemaVersion: 1, kind: 'inheritedContext', sourceThreadId: thread.id,
      coveredThrough: { turnId: first.id, itemId: first.items.at(-1)!.id }, requestedTurns: 'all', turns: [first] };
    const ref = f.write(payload), dependencies = contextPayloadDependencies(payload);
    const inherited = contextEvidenceItem({ thread, turnId: uuidV7(), createItemId: uuidV7 }, 'inheritedContext', ref, 'Inherited context', dependencies.resources,
      { contextRefs: dependencies.contexts, internalTextRefs: dependencies.internalTexts, outputRefs: dependencies.outputs });
    learn(f.store, 'b', 'EVIDENCE FIRST');
    const forkTurn = await f.input(f.state(), [inherited]);
    const projected = await f.project([forkTurn]);
    const prefix = await f.project([first]);
    expect(projected.slice(0, prefix.length)).toEqual(prefix);
    expect(text(projected[prefix.length])).toContain('EVIDENCE FIRST');
  });
  test('rerun preserves its original Profile while live withdrawal appends a new canonical snapshot', async () => {
    const f = fixture();
    learn(f.store, 'a');
    captureProfileTurn(f.store, thread.id, 'original-turn', 'default', true);
    const original = profileStateForTurn(f.store, 'original-turn', true);
    const first = await f.input(original);
    learn(f.store, 'b', 'NEW FILE VALUE');
    captureReplayedProfileTurn(f.store, 'replayed-turn', 'original-turn');
    expect(profileStateForTurn(f.store, 'replayed-turn', true)).toEqual(original);
    const toSnapshot = (state: AdditionalContext) => additionalContextPayload(undefined,
      [{ extensionId: 'memory', additionalContext: state, applicationInstructions: true }], true);
    expect(await planAdditionalContextState([first], toSnapshot(original), f.read)).toBeNull();
    f.store.commitInvalidation('rollback:a', ['turn:a']);
    const withdrawn = profileStateForTurn(f.store, 'replayed-turn', true);
    expect(withdrawn.profile_user_reports).toBeUndefined();
    const update = (await planAdditionalContextState([first], toSnapshot(withdrawn), f.read))!;
    const ref = f.write(update), turnId = uuidV7();
    const item = contextEvidenceItem({ thread, turnId, createItemId: uuidV7 }, 'additionalContext', ref, 'Updated context', []);
    const before = await f.project([first]);
    const after = await f.project([first, turn(turnId, [item])]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(text(after.at(-1)!)).toContain('Profile preference reports');
    expect(text(after.at(-1)!)).toContain('no longer active');
    expect(text(after.at(-1)!)).not.toContain('NEW FILE VALUE');
    expect(await planAdditionalContextState([first, turn(turnId, [item])], toSnapshot(withdrawn), f.read)).toBeNull();
  });

});
