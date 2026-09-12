import { describe, expect, test } from 'bun:test';
import { AutomationRendererStore, type AutomationStoreClient } from '../../src/renderer/agent/automations/automationStore';
import type { ScheduledRunResult } from '../../src/core/agent/scheduledResult';
import type { AutomationResponseByMethod, AutomationRun } from '../../src/core/agent/automation';

function result(state: ScheduledRunResult['state'], id = 'run-one'): ScheduledRunResult {
  return { run: { id, automationId: 'task-one', threadId: 'thread-one', state: 'dispatched', createdSequence: id === 'run-one' ? 1 : 2 } as AutomationRun,
    state, resultTurnId: 'turn-one', answer: null, answerTruncated: false, parts: [], issues: [], issue: null, issueKey: null, acknowledged: false,
    startedAt: 1, finishedAt: null, recordPath: null };
}
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe('Scheduled run controls share the renderer owner', () => {
  test('concurrent stop clicks share one request and a stale read cannot restore Running', async () => {
    const read = defer<ScheduledRunResult>();
    const stopped = defer<ScheduledRunResult>();
    const calls: Array<{ method: string; input: unknown }> = [];
    const store = new AutomationRendererStore({ onAutomationNotification: () => () => undefined,
      automationRequest(method, input) { calls.push({ method, input });
        if (method === 'result') return read.promise;
        if (method === 'runStop') return stopped.promise;
        return Promise.resolve({ attentionCount: 0, current: null, latest: null });
      } } as unknown as AutomationStoreClient);
    const oldRead = store.readRunResult('run-one');
    const first = store.stopRun('run-one'); const repeated = store.stopRun('run-one');
    expect(first).toBe(repeated);
    expect(store.getSnapshot().runOperations.get('run-one')?.pending).toBe(true);
    stopped.resolve(result('stopping')); await first;
    read.resolve(result('running')); await oldRead;
    expect(store.getSnapshot().runResults.get('run-one')?.state).toBe('stopping');
    expect(calls.filter((call) => call.method === 'runStop')).toEqual([{ method: 'runStop', input: { id: 'run-one', requestId: expect.any(String) } }]);
  });

  test('failed stop delivery preserves its identity for retry and does not claim cancellation', async () => {
    const requests: Array<{ requestId: string }> = [];
    const store = new AutomationRendererStore({ onAutomationNotification: () => () => undefined,
      async automationRequest(method, input) {
        if (method === 'result') return result('running');
        if (method === 'runStop') {
          requests.push(input as { requestId: string });
          if (requests.length === 1) throw new Error('Lost stop reply');
          return result('interrupted');
        }
        return { attentionCount: 0, current: null, latest: null };
      } } as unknown as AutomationStoreClient);
    await store.readRunResult('run-one');
    await expect(store.stopRun('run-one')).rejects.toThrow('Lost stop reply');
    expect(store.getSnapshot().runResults.get('run-one')?.state).toBe('running');
    expect(store.getSnapshot().runOperations.get('run-one')).toMatchObject({ pending: false, error: 'Lost stop reply' });
    await store.stopRun('run-one');
    expect(requests[0]?.requestId).toBe(requests[1]?.requestId);
    expect(store.getSnapshot().runResults.get('run-one')?.state).toBe('interrupted');
  });

  test('overlapping history loads cannot replace newer task history with an older page', async () => {
    const oldPage = defer<{ data: AutomationRun[] }>(); let count = 0;
    const store = new AutomationRendererStore({ onAutomationNotification: () => () => undefined,
      async automationRequest(method, input) {
        if (method === 'runs') return ++count === 1 ? oldPage.promise : { data: [result('completed', 'run-two').run] };
        if (method === 'timing') return { missed: [] };
        if (method === 'result') return result('completed', (input as { id: string }).id);
        throw new Error(method);
      } } as unknown as AutomationStoreClient);
    const old = store.loadTaskHistory('task-one');
    await store.loadTaskHistory('task-one');
    oldPage.resolve({ data: [result('completed').run] }); await old;
    expect(store.getSnapshot().taskViews.get('task-one')?.runIds).toEqual(['run-two']);
  });

  test('summary results share the cache without restoring a pre-stop state', async () => {
    const oldSummary = defer<AutomationResponseByMethod['summary']>();
    let summaries = 0;
    const store = new AutomationRendererStore({ onAutomationNotification: () => () => undefined,
      async automationRequest(method) {
        if (method === 'result') return result('running');
        if (method === 'runStop') return result('stopping');
        if (method === 'summary') {
          if (++summaries === 1) return oldSummary.promise;
          return { attentionCount: 0, current: summaries === 2 ? result('stopping') : null, latest: result(summaries === 2 ? 'stopping' : 'interrupted') };
        }
        throw new Error(method);
      } } as unknown as AutomationStoreClient);
    await store.readRunResult('run-one');
    const pending = store.loadTaskSummary('task-one');
    await store.stopRun('run-one');
    oldSummary.resolve({ attentionCount: 0, current: result('running'), latest: result('running') });
    await pending;
    expect(store.getSnapshot().runResults.get('run-one')?.state).toBe('stopping');
    await store.loadTaskSummary('task-one');
    expect(store.getSnapshot().runResults.get('run-one')?.state).toBe('interrupted');
    expect(store.getSnapshot().taskViews.get('task-one')?.summary).toEqual({ attentionCount: 0, currentRunId: null, latestRunId: 'run-one' });
  });

});
