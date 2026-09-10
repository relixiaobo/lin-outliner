import { describe, expect, test } from 'bun:test';
import type { RequestUserInputRequest, UserInputReadResponse, UserInputSettlement } from '../../src/core/agent/protocol';
import { userInputKey } from '../../src/core/agent/userInput';
import { ThreadUserInputState, activeInputAnswers, recoveryText } from '../../src/renderer/agent/store/userInputState';

const request = (itemId = 'question-1', revision = 1, threadId = 'thread-1'): RequestUserInputRequest => ({
  hostGeneration: 'host-1', threadId, turnId: 'turn-1', itemId, revision, deadlineAt: Date.now() + 60_000, autoResolutionMs: 60_000,
  questions: [
    { id: 'scope', header: 'Scope', question: 'How broad?', options: [{ label: 'Small', description: 'One module.' }, { label: 'Full', description: 'All modules.' }] },
    { id: 'schedule', header: 'Schedule', question: 'When?', options: [{ label: 'Now', description: 'Today.' }, { label: 'Later', description: 'Tomorrow.' }] },
  ],
});
const pendingRead = (pending: RequestUserInputRequest): UserInputReadResponse => ({ state: {
  threadId: pending.threadId, hostGeneration: pending.hostGeneration, revision: pending.revision, activeTurnId: pending.turnId, pending, settled: null,
}, observed: null });
const settlement = (pending: RequestUserInputRequest, outcome: UserInputSettlement['outcome'] = 'timedOut'): UserInputSettlement => ({
  hostGeneration: pending.hostGeneration, threadId: pending.threadId, turnId: pending.turnId, itemId: pending.itemId,
  revision: pending.revision + 1, deadlineAt: pending.deadlineAt, outcome,
  ...(outcome === 'answered' ? { submitted: { submissionId: 'submit-1', intent: 'answer' as const, answers: [{ questionId: 'scope', optionLabel: 'Full' }, { questionId: 'schedule', skipped: true as const }] } } : {}),
});
function clear(owner: ThreadUserInputState, pending: RequestUserInputRequest, outcome: UserInputSettlement['outcome'] = 'timedOut') {
  const settled = settlement(pending, outcome);
  owner.notification({ type: 'userInput/cleared', threadId: pending.threadId, turnId: pending.turnId, itemId: pending.itemId, settlement: settled });
}
function ask(owner: ThreadUserInputState, pending: RequestUserInputRequest) {
  owner.notification({ type: 'userInput/requested', threadId: pending.threadId, turnId: pending.turnId, itemId: pending.itemId, request: pending });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('session user input projection', () => {
  test('reconciled submission releases answered content but retains only text withheld by skipped questions', () => {
    const question = request();
    const owner = new ThreadUserInputState(async () => pendingRead(question), () => {}, () => false);
    ask(owner, question);
    owner.updateDraft(question, { answers: { scope: { optionLabel: 'Full' }, schedule: { otherText: 'Not ready to share', skipped: true } }, step: 1 });
    const accepted = settlement(question, 'answered');
    const response = { state: { ...pendingRead(question).state, revision: 2, pending: null, settled: accepted }, observed: accepted };
    owner.applyRead(response, question);
    const key = userInputKey(question);
    expect(owner.getSnapshot().userInputByThread.size).toBe(0);
    expect(owner.getSnapshot().userInputDrafts.get(key)).toMatchObject({ outcome: 'skipped', answers: { schedule: { otherText: 'Not ready to share' } } });
    expect(recoveryText(owner.getSnapshot().userInputDrafts.get(key)!)).toBe('When?\nNot ready to share');
    owner.applyRead(response, question);
    expect(recoveryText(owner.getSnapshot().userInputDrafts.get(key)!)).toBe('When?\nNot ready to share');
  });
  test('recovers a dropped request, coalesces reads, and keeps all edited steps across remount and reconciliation', async () => {
    const question = request();
    const response = deferred<UserInputReadResponse>();
    let reads = 0;
    const owner = new ThreadUserInputState(() => { reads += 1; return response.promise; }, () => {}, () => true);
    const first = owner.reconcile(question.threadId);
    expect(owner.reconcile(question.threadId)).toBe(first);
    expect(owner.getSnapshot().userInputRecoveryByThread.get(question.threadId)).toBe('restoring');
    response.resolve(pendingRead(question));
    await first;
    owner.updateDraft(question, { answers: { scope: { optionLabel: 'Full' }, schedule: { otherText: 'After the release' } }, step: 1 });
    owner.applyRead(pendingRead(question));
    expect(reads).toBe(1);
    expect(owner.getSnapshot().userInputDrafts.get(userInputKey(question))).toMatchObject({ step: 1, answers: { scope: { optionLabel: 'Full' }, schedule: { otherText: 'After the release' } } });
  });

  test('a waiting notification during an old empty read forces a fresh snapshot even when the request event was lost', async () => {
    const question = request();
    const old = deferred<UserInputReadResponse>();
    let reads = 0;
    const owner = new ThreadUserInputState(() => ++reads === 1 ? old.promise : Promise.resolve(pendingRead(question)), () => {}, () => true);
    const initial = owner.reconcile(question.threadId);
    owner.reconcile(question.threadId, true);
    old.resolve({ state: { ...pendingRead(question).state, revision: 0, pending: null, activeTurnId: null }, observed: null });
    await initial;
    expect(reads).toBe(2);
    expect(owner.getSnapshot().userInputByThread.get(question.threadId)).toEqual(question);
  });

  test('ordered snapshots and events cannot resurrect settled forms or remove a newer question', () => {
    const first = request();
    const owner = new ThreadUserInputState(async () => pendingRead(first), () => {}, () => false);
    ask(owner, first);
    clear(owner, first);
    owner.applyRead(pendingRead(first));
    ask(owner, first);
    expect(owner.getSnapshot().userInputByThread.size).toBe(0);
    const next = request('question-2', 3);
    ask(owner, next);
    owner.applyRead({ state: { ...pendingRead(first).state, revision: 2, pending: null, settled: settlement(first) }, observed: null });
    clear(owner, first);
    expect(owner.getSnapshot().userInputByThread.get(first.threadId)?.itemId).toBe(next.itemId);
  });

  test('timeout preserves every unsent answer independently of newer requests', () => {
    const first = request();
    const owner = new ThreadUserInputState(async () => pendingRead(first), () => {}, () => false);
    ask(owner, first);
    owner.updateDraft(first, { answers: { scope: { optionLabel: 'Full' }, schedule: { otherText: 'Partial text' } }, step: 1 });
    clear(owner, first);
    const key = userInputKey(first);
    const draft = owner.getSnapshot().userInputDrafts.get(key)!;
    expect(draft.outcome).toBe('timedOut');
    expect(recoveryText(draft)).toBe('How broad?\nFull\n\nWhen?\nPartial text');
    const next = request('question-2', 3);
    ask(owner, next);
    owner.updateDraft(next, { answers: { scope: { optionLabel: 'Small' } } });
    expect(owner.getSnapshot().userInputDrafts.get(key)).toEqual(draft);
    owner.applyRead(pendingRead(next));
    expect(recoveryText(owner.getSnapshot().userInputDrafts.get(key)!)).toContain('Partial text');
    expect(owner.getSnapshot().userInputDrafts.get(userInputKey(next))?.answers.scope).toEqual({ optionLabel: 'Small' });
  });

  test('lost acceptance reply reconciles exactly the old draft after a newer question supersedes it', async () => {
    const first = request();
    const next = request('question-2', 3);
    const owner = new ThreadUserInputState(async () => ({ ...pendingRead(next), observed: settlement(first, 'answered') }), () => {}, () => false);
    ask(owner, first);
    owner.updateDraft(first, { answers: { scope: { optionLabel: 'Full' } } });
    ask(owner, next);
    await owner.reconcile(first.threadId);
    expect(owner.getSnapshot().userInputDrafts.has(userInputKey(first))).toBe(false);
    expect(owner.getSnapshot().userInputDrafts.has(userInputKey(next))).toBe(true);
  });

  test('read failure and inconsistent waiting show reachable error state without losing drafts', async () => {
    const question = request();
    const owner = new ThreadUserInputState(async () => { throw new Error('transport down'); }, () => {}, () => true);
    ask(owner, question);
    owner.updateDraft(question, { answers: { schedule: { otherText: 'Keep me' } } });
    await owner.reconcile(question.threadId);
    expect(owner.getSnapshot().userInputRecoveryByThread.get(question.threadId)).toBe('error');
    expect(owner.getSnapshot().userInputDrafts.get(userInputKey(question))?.answers.schedule?.otherText).toBe('Keep me');
    const inconsistent = new ThreadUserInputState(async () => ({ state: { ...pendingRead(question).state, pending: null }, observed: null }), () => {}, () => true);
    await inconsistent.reconcile(question.threadId);
    expect(inconsistent.getSnapshot().userInputRecoveryByThread.get(question.threadId)).toBe('error');
  });

  test('Host replacement invalidates old authority, retains text, and ignores delayed old-generation state', () => {
    const question = request();
    const owner = new ThreadUserInputState(async () => pendingRead(question), () => {}, () => false);
    ask(owner, question);
    owner.updateDraft(question, { answers: { scope: { optionLabel: 'Full' } } });
    owner.applyRead({ state: { threadId: question.threadId, hostGeneration: 'host-2', revision: 0, activeTurnId: null, pending: null, settled: null }, observed: null });
    owner.applyRead(pendingRead(question));
    ask(owner, question);
    expect(owner.getSnapshot().userInputByThread.size).toBe(0);
    expect(owner.getSnapshot().userInputDrafts.get(userInputKey(question))?.outcome).toBe('invalidated');
  });

  test('terminal Turn fences delayed pending state and Thread deletion removes only its drafts', async () => {
    const question = request();
    const owner = new ThreadUserInputState(async () => pendingRead(question), () => {}, () => false);
    ask(owner, question);
    owner.notification({ type: 'turn/completed', threadId: question.threadId, turnId: question.turnId } as any);
    await owner.reconcile(question.threadId);
    expect(owner.getSnapshot().userInputByThread.size).toBe(0);
    const other = request('question-other', 1, 'thread-other');
    ask(owner, other);
    owner.removeThread(question.threadId);
    expect(owner.getSnapshot().userInputDrafts.has(userInputKey(question))).toBe(false);
    expect(owner.getSnapshot().userInputDrafts.has(userInputKey(other))).toBe(true);
  });
});

test('accepted content releases only exact submitted values and leaves newer edits and inactive alternatives recoverable', () => {
  const question = request();
  const owner = new ThreadUserInputState(async () => pendingRead(question), () => {}, () => false);
  ask(owner, question);
  owner.updateDraft(question, { answers: { scope: { optionLabel: 'Full', otherText: 'An inactive alternative', selection: 'option' },
    schedule: { otherText: 'A new edit', selection: 'text' } } });
  expect(activeInputAnswers(owner.getSnapshot().userInputDrafts.get(userInputKey(question))!)).toEqual([
    { questionId: 'scope', optionLabel: 'Full' }, { questionId: 'schedule', otherText: 'A new edit' },
  ]);
  const accepted = { ...settlement(question, 'answered'), submitted: { submissionId: 'submit-1', intent: 'continue' as const,
    answers: [{ questionId: 'scope', optionLabel: 'Full' }, { questionId: 'schedule', otherText: 'The submitted edit' }] } };
  owner.applyRead({ state: { ...pendingRead(question).state, revision: 2, pending: null, settled: accepted }, observed: accepted });
  const retained = owner.getSnapshot().userInputDrafts.get(userInputKey(question))!;
  expect(recoveryText(retained)).toContain('An inactive alternative');
  expect(recoveryText(retained)).toContain('A new edit');
  expect(recoveryText(retained)).not.toContain('Full');
});
