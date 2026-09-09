import type {
  RequestUserInputRequest, UserInputIdentity, UserInputState,
  UserInputSettlement, UserInputReadResponse, RendererAgentCoreNotification,
} from '../../../core/agent/protocol';
import { sameUserInput, userInputKey } from '../../../core/agent/userInput';

export interface UserInputDraft {
  readonly request: RequestUserInputRequest;
  readonly answers: Readonly<Record<string, { readonly optionLabel?: string; readonly otherText?: string; readonly skipped?: true }>>;
  readonly step: number;
  readonly outcome: 'pending' | 'unknown' | 'invalidated' | 'skipped' | UserInputSettlement['outcome'];
  readonly addedToMessage: boolean;
}

export interface UserInputProjection {
  readonly userInputByThread: ReadonlyMap<string, RequestUserInputRequest>;
  readonly userInputDrafts: ReadonlyMap<string, UserInputDraft>;
  readonly userInputRecoveryByThread: ReadonlyMap<string, 'restoring' | 'error'>;
}

export const EMPTY_USER_INPUT: UserInputProjection = {
  userInputByThread: new Map(), userInputDrafts: new Map(), userInputRecoveryByThread: new Map(),
};

/** Session-local projection owned by ThreadStore. No draft crosses the Host boundary until Submit/Send. */
export class ThreadUserInputState {
  private projection = EMPTY_USER_INPUT;
  private generation: string | null = null;
  private readonly retiredGenerations = new Set<string>();
  private readonly states = new Map<string, UserInputState>();
  private readonly endedTurns = new Set<string>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly readInvalidations = new Map<string, number>();
  private readonly deletedThreads = new Set<string>();

  constructor(
    private readonly read: (threadId: string, observed?: UserInputIdentity) => Promise<UserInputReadResponse>,
    private readonly changed: (projection: UserInputProjection) => void,
    private readonly isWaiting: (threadId: string) => boolean,
    private readonly waitingChanged: (threadId: string, waiting: boolean) => void = () => undefined,
  ) {}

  getSnapshot(): UserInputProjection { return this.projection; }

  updateDraft(request: RequestUserInputRequest, update: Partial<Pick<UserInputDraft, 'answers' | 'step'>>): void {
    const key = userInputKey(request);
    const draft = this.projection.userInputDrafts.get(key);
    if (!draft || draft.outcome !== 'pending') return;
    const drafts = new Map(this.projection.userInputDrafts);
    drafts.set(key, { ...draft, ...update });
    this.patch({ userInputDrafts: drafts });
  }

  discard(key: string): void {
    const drafts = new Map(this.projection.userInputDrafts);
    if (drafts.get(key)?.outcome === 'pending') return;
    drafts.delete(key);
    this.patch({ userInputDrafts: drafts });
  }

  markAdded(key: string): void {
    const drafts = new Map(this.projection.userInputDrafts);
    const draft = drafts.get(key);
    if (draft && draft.outcome !== 'pending') {
      drafts.set(key, { ...draft, addedToMessage: true });
      this.patch({ userInputDrafts: drafts });
    }
  }

  acceptMessage(threadId: string, keys: readonly string[]): void {
    for (const key of keys) {
      const draft = this.projection.userInputDrafts.get(key);
      if (draft?.request.threadId === threadId && draft.addedToMessage) this.discard(key);
    }
  }

  removeThread(threadId: string): void {
    this.deletedThreads.add(threadId);
    this.states.delete(threadId);
    const requests = new Map(this.projection.userInputByThread);
    const drafts = new Map(this.projection.userInputDrafts);
    const recovery = new Map(this.projection.userInputRecoveryByThread);
    requests.delete(threadId);
    recovery.delete(threadId);
    for (const [key, draft] of drafts) if (draft.request.threadId === threadId) drafts.delete(key);
    this.patch({ userInputByThread: requests, userInputDrafts: drafts, userInputRecoveryByThread: recovery });
  }

  reconcile(threadId: string, invalidateRead = false): Promise<void> {
    if (invalidateRead) this.readInvalidations.set(threadId, (this.readInvalidations.get(threadId) ?? 0) + 1);
    const inflight = this.reads.get(threadId);
    if (inflight) return inflight;
    if (this.deletedThreads.has(threadId)) return Promise.resolve();
    const wasWaiting = this.isWaiting(threadId);
    this.setRecovery(threadId, 'restoring');
    const observed = [...this.projection.userInputDrafts.values()]
      .filter((draft) => draft.request.threadId === threadId && (draft.outcome === 'pending' || draft.outcome === 'unknown'))
      .map((draft) => identityOf(draft.request));
    const operation = (async () => {
      try {
        // Each response is bounded and resolves only the exact previously observed request.
        for (const identity of observed.length ? observed : [undefined]) {
          let invalidation = this.readInvalidations.get(threadId) ?? 0;
          const startedGeneration = this.generation;
          let response = await this.read(threadId, identity);
          // A waiting notification can arrive after an empty snapshot was captured while its request event was lost.
          // Re-read only for explicit invalidations; coalescing must not swallow that recovery trigger.
          while (invalidation !== (this.readInvalidations.get(threadId) ?? 0)) {
            invalidation = this.readInvalidations.get(threadId) ?? 0;
            response = await this.read(threadId, identity);
          }
          // A notification from another Host arrived during this read. Establish its epoch with a fresh read.
          if (this.generation !== startedGeneration && response.state.hostGeneration !== this.generation) {
            response = await this.read(threadId, identity);
          }
          if (this.deletedThreads.has(threadId)) return;
          this.applyRead(response, identity);
        }
        const state = this.states.get(threadId);
        if (wasWaiting && !state?.pending && state?.activeTurnId && !state.settled) {
          this.setRecovery(threadId, 'error');
        } else this.setRecovery(threadId, null);
      } catch {
        this.trace('snapshot-error', threadId);
        this.setRecovery(threadId, 'error');
      }
    })();
    this.reads.set(threadId, operation);
    void operation.finally(() => { if (this.reads.get(threadId) === operation) this.reads.delete(threadId); });
    return operation;
  }

  applyRead(response: UserInputReadResponse, observed?: UserInputIdentity): void {
    const { state } = response;
    if (this.retiredGenerations.has(state.hostGeneration)) { this.trace('stale-generation', state.threadId); return; }
    if (this.generation !== state.hostGeneration) {
      if (this.generation) this.retiredGenerations.add(this.generation);
      this.generation = state.hostGeneration;
      this.states.clear();
      const drafts = new Map(this.projection.userInputDrafts);
      for (const [key, draft] of drafts) {
        if (draft.request.hostGeneration !== this.generation && (draft.outcome === 'pending' || draft.outcome === 'unknown')) {
          drafts.set(key, { ...draft, outcome: 'invalidated' });
        }
      }
      this.patch({ userInputByThread: new Map(), userInputDrafts: drafts });
    }
    if (response.observed) this.applySettlement(response.observed);
    this.mergeState(state);
    if (observed && !response.observed && (!state.pending || !sameUserInput(observed, state.pending))) {
      const key = userInputKey(observed);
      const draft = this.projection.userInputDrafts.get(key);
      if (draft?.outcome === 'pending') this.retain(draft.request, observed.hostGeneration === state.hostGeneration ? 'unknown' : 'invalidated');
    }
    this.trace('reconciled', state.threadId);
  }

  notification(notification: RendererAgentCoreNotification): void {
    if (notification.type === 'turn/completed') {
      this.endedTurns.add(`${notification.threadId}:${notification.turnId}`);
      const request = this.projection.userInputByThread.get(notification.threadId);
      if (request?.turnId === notification.turnId) {
        this.retain(request, 'unknown');
        void this.reconcile(notification.threadId);
      }
      return;
    }
    if (notification.type !== 'userInput/requested' && notification.type !== 'userInput/resolved' && notification.type !== 'userInput/cleared') return;
    const entry = notification.type === 'userInput/requested' ? notification.request : notification.settlement;
    if (this.deletedThreads.has(entry.threadId)) return;
    if (this.retiredGenerations.has(entry.hostGeneration)) { this.trace('stale-event', entry.threadId); return; }
    if (this.generation && this.generation !== entry.hostGeneration) {
      void this.reconcile(entry.threadId);
      return;
    }
    this.generation = entry.hostGeneration;
    const prior = this.states.get(entry.threadId);
    if (notification.type !== 'userInput/requested') this.applySettlement(notification.settlement);
    this.mergeState({
      threadId: entry.threadId, hostGeneration: entry.hostGeneration, revision: entry.revision,
      activeTurnId: notification.type === 'userInput/requested' ? entry.turnId : prior?.activeTurnId ?? entry.turnId,
      pending: notification.type === 'userInput/requested' ? notification.request : null,
      settled: notification.type === 'userInput/requested' ? prior?.settled ?? null : notification.settlement,
    });
  }

  private mergeState(state: UserInputState): void {
    const current = this.states.get(state.threadId);
    if (current && state.revision < current.revision) { this.trace('stale-revision', state.threadId); return; }
    this.states.set(state.threadId, state);
    this.waitingChanged(state.threadId, Boolean(state.pending && !this.endedTurns.has(`${state.threadId}:${state.pending.turnId}`)));
    if (state.settled) this.applySettlement(state.settled);
    const pending = state.pending;
    const previous = this.projection.userInputByThread.get(state.threadId);
    if (previous && (!pending || !sameUserInput(previous, pending))) this.retain(previous, 'unknown');
    if (pending && !this.endedTurns.has(`${pending.threadId}:${pending.turnId}`)) {
      const requests = new Map(this.projection.userInputByThread);
      const drafts = new Map(this.projection.userInputDrafts);
      const key = userInputKey(pending);
      const old = drafts.get(key);
      if (old && old.outcome !== 'pending' && old.outcome !== 'unknown') return;
      requests.set(state.threadId, pending);
      drafts.set(key, old ? { ...old, outcome: 'pending' } : {
        request: pending, answers: {}, step: 0, outcome: 'pending', addedToMessage: false,
      });
      this.patch({ userInputByThread: requests, userInputDrafts: drafts });
      this.setRecovery(state.threadId, null);
    }
  }

  private applySettlement(settlement: UserInputSettlement): void {
    const key = userInputKey(settlement);
    const requests = new Map(this.projection.userInputByThread);
    const drafts = new Map(this.projection.userInputDrafts);
    const current = requests.get(settlement.threadId);
    if (current && sameUserInput(current, settlement)) requests.delete(settlement.threadId);
    const draft = drafts.get(key);
    if (settlement.outcome === 'answered' && settlement.skippedQuestionIds?.length && draft) {
      // Acceptance releases submitted answers only. Text withheld by Skip stays local and unsent.
      const answers = Object.fromEntries(Object.entries(draft.answers).filter(([id]) => settlement.skippedQuestionIds!.includes(id)));
      const retained = { ...draft, answers, outcome: 'skipped' as const };
      if (recoveryText(retained)) drafts.set(key, retained);
      else drafts.delete(key);
    } else if (settlement.outcome === 'answered') drafts.delete(key);
    else if (draft) drafts.set(key, { ...draft, outcome: settlement.outcome });
    this.patch({ userInputByThread: requests, userInputDrafts: drafts });
  }

  private retain(request: RequestUserInputRequest, outcome: UserInputDraft['outcome']): void {
    const requests = new Map(this.projection.userInputByThread);
    const current = requests.get(request.threadId);
    if (current && sameUserInput(current, request)) requests.delete(request.threadId);
    const drafts = new Map(this.projection.userInputDrafts);
    const key = userInputKey(request);
    const draft = drafts.get(key);
    if (draft?.outcome === 'pending') drafts.set(key, { ...draft, outcome });
    this.patch({ userInputByThread: requests, userInputDrafts: drafts });
  }

  private setRecovery(threadId: string, value: 'restoring' | 'error' | null): void {
    const recovery = new Map(this.projection.userInputRecoveryByThread);
    if (value) recovery.set(threadId, value);
    else recovery.delete(threadId);
    this.patch({ userInputRecoveryByThread: recovery });
  }

  private patch(update: Partial<UserInputProjection>): void {
    this.projection = { ...this.projection, ...update };
    this.changed(this.projection);
  }

  private trace(boundary: string, threadId: string): void {
    const state = this.states.get(threadId);
    console.info('[agent:user-input]', boundary, { threadId, hostGeneration: this.generation, revision: state?.revision,
      turnId: state?.pending?.turnId ?? state?.settled?.turnId, itemId: state?.pending?.itemId ?? state?.settled?.itemId });
  }
}

export function identityOf(request: UserInputIdentity): UserInputIdentity {
  return { hostGeneration: request.hostGeneration, threadId: request.threadId, turnId: request.turnId, itemId: request.itemId };
}

export function recoveryText(draft: UserInputDraft): string {
  return draft.request.questions.flatMap((question) => {
    const answer = draft.answers[question.id];
    const text = answer?.optionLabel ?? answer?.otherText;
    return text ? [`${question.question}\n${text}`] : [];
  }).join('\n\n');
}
