import { describe, expect, test } from 'bun:test';
import type { DocumentProjection } from '../../src/core/types';
import {
  DesktopHostLifecycle,
  type DesktopHostLifecycleOptions,
  type DesktopHostQuitOutcome,
} from '../../src/main/desktopHostLifecycle';
import { createAgentHostLifecycle } from '../../src/main/hostDomain/compositionLifecycle';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((settle) => { resolve = settle; }),
    resolve: () => resolve(),
  };
}

function createHarness(overrides: Partial<DesktopHostLifecycleOptions> = {}) {
  const events: string[] = [];
  let quitOutcome: DesktopHostQuitOutcome = 'disposed';
  const lifecycle = new DesktopHostLifecycle({
    startSteps: [
      { name: 'outline-documents', run: () => { events.push('documents'); } },
      { name: 'agent', run: () => { events.push('agent'); } },
      { name: 'publication', run: () => { events.push('publication'); } },
    ],
    closeAdmission: () => { events.push('freeze'); },
    ordinaryQuit: async () => {
      events.push('ordinary-quit');
      return quitOutcome;
    },
    rollback: async (_milestones, cause) => { events.push(`rollback:${cause}`); },
    exitAfterStartupFailure: () => { events.push('exit:failure'); },
    exitAfterEarlyQuit: () => { events.push('exit:quit'); },
    ...overrides,
  });
  return {
    events,
    lifecycle,
    setQuitOutcome: (outcome: DesktopHostQuitOutcome) => { quitOutcome = outcome; },
  };
}

describe('DesktopHostLifecycle', () => {
  test('shows the window before services and gates each request on its owning DAG boundary', async () => {
    const document = deferred();
    const providers = deferred();
    const ranking = deferred();
    const events: string[] = [];
    const { lifecycle } = createHarness({
      startSteps: [
        { name: 'windows', run: () => { events.push('window'); } },
        { name: 'provider-configuration', dependsOn: ['windows'], run: () => providers.promise },
        { name: 'outline-documents', dependsOn: ['windows'], run: () => document.promise },
        { name: 'personal-ranking', dependsOn: ['windows'], run: () => {
          events.push('ranking:load');
          return ranking.promise;
        } },
        { name: 'agent', dependsOn: ['provider-configuration', 'outline-documents'], run: () => {
          events.push('threads');
        } },
      ],
    });
    const start = lifecycle.start();
    const projection = lifecycle.ready('outline-documents').then(() => events.push('projection:reply'));
    const search = lifecycle.ready('personal-ranking').then(() => events.push('search:reply'));
    const agent = lifecycle.ready('agent').then(() => events.push('agent:reply'));
    while (!events.includes('ranking:load')) await Promise.resolve();
    expect(events).toEqual(['window', 'ranking:load']);
    document.resolve();
    await projection;
    expect(events).not.toContain('threads');
    expect(events).not.toContain('search:reply');
    providers.resolve();
    await agent;
    expect(events).toContain('threads');
    expect(events).not.toContain('search:reply');
    ranking.resolve();
    await Promise.all([start, search]);
    expect(lifecycle.state()).toEqual({ status: 'ready' });
  });

  test('keeps a recoverable failure visible and retries only unfinished services once', async () => {
    let attempts = 0;
    let windows = 0;
    const error = new Error('Unreadable workspace');
    const { lifecycle, events } = createHarness({
      startSteps: [
        { name: 'windows', run: () => { windows += 1; } },
        { name: 'outline-documents', retryable: true, run: () => {
          attempts += 1;
          if (attempts === 1) throw error;
        } },
        { name: 'agent', run: () => undefined },
      ],
    });
    const first = lifecycle.start();
    const request = lifecycle.ready('outline-documents');
    expect(lifecycle.ready('outline-documents')).toBe(request);
    const results = await Promise.allSettled([first, request]);
    expect(results).toEqual([
      { status: 'rejected', reason: error }, { status: 'rejected', reason: error },
    ]);
    expect(lifecycle.phase()).toBe('failed');
    expect(lifecycle.state()).toEqual({ status: 'failed', step: 'outline-documents', message: error.message });
    expect(events).toEqual([]);
    await expect(lifecycle.ready('outline-documents')).rejects.toBe(error);
    expect(attempts).toBe(1);
    const retry = lifecycle.start();
    expect(lifecycle.start()).toBe(retry);
    await retry;
    expect(windows).toBe(1);
    expect(attempts).toBe(2);
    expect(lifecycle.phase()).toBe('started');
  });

  test('drains parallel startup work before retry and allows Quit from the failure surface', async () => {
    const sibling = deferred();
    let siblingStarted = false;
    const { lifecycle, events } = createHarness({
      startSteps: [
        { name: 'windows', run: () => undefined },
        { name: 'outline-documents', retryable: true, run: () => { throw new Error('Broken'); } },
        { name: 'ranking-load', dependsOn: ['windows'], run: () => {
          siblingStarted = true;
          return sibling.promise;
        } },
      ],
    });
    const start = lifecycle.start();
    const outcome = start.catch(() => undefined);
    while (!siblingStarted) await Promise.resolve();
    expect(lifecycle.phase()).toBe('starting');
    expect(lifecycle.start()).toBe(start);
    sibling.resolve();
    await outcome;
    expect(lifecycle.phase()).toBe('failed');
    await lifecycle.requestQuit();
    expect(events).toEqual(['freeze', 'rollback:quit-before-start', 'exit:quit']);
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('Cancel in safe quit preserves a service failure until an explicit Retry', async () => {
    let attempts = 0;
    const { lifecycle, setQuitOutcome } = createHarness({
      startSteps: [
        { name: 'outline-documents', run: () => undefined },
        { name: 'agent', retryable: true, run: () => {
          attempts += 1;
          throw new Error('Agent preparation failed');
        } },
      ],
    });
    await expect(lifecycle.start()).rejects.toThrow('Agent preparation failed');
    setQuitOutcome('cancelled');
    await lifecycle.requestQuit();
    expect(lifecycle.phase()).toBe('failed');
    expect(lifecycle.state().status).toBe('failed');
    expect(attempts).toBe(1);
    await expect(lifecycle.start()).rejects.toThrow('Agent preparation failed');
    expect(attempts).toBe(2);
  });

  test('starts once and records each completed boundary', async () => {
    const { events, lifecycle } = createHarness();
    const first = lifecycle.start();
    const second = lifecycle.start();
    expect(first).toBe(second);
    await first;
    expect(lifecycle.phase()).toBe('started');
    expect([...lifecycle.completedMilestones()]).toEqual(['outline-documents', 'agent', 'publication']);
    expect(events).toEqual(['documents', 'agent', 'publication']);
  });

  test('quit closes admission synchronously and prevents the next startup step', async () => {
    const boundary = deferred();
    const { events, lifecycle } = createHarness({
      startSteps: [
        { name: 'outline-documents', run: () => boundary.promise },
        { name: 'producer', run: () => { events.push('producer'); } },
      ],
    });
    const startup = lifecycle.start();
    await Promise.resolve();
    const quitting = lifecycle.requestQuit();
    expect(events).toEqual(['freeze']);
    boundary.resolve();
    await Promise.all([startup, quitting]);
    expect(events).not.toContain('producer');
    expect(events).toContain('ordinary-quit');
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('quit wins at every awaited startup boundary without starting a later producer', async () => {
    for (const boundaryIndex of [0, 1, 2]) {
      const boundary = deferred();
      const events: string[] = [];
      const steps = ['outline-documents', 'agent', 'publication'].map((name, index) => ({
        name,
        run: () => {
          events.push(`start:${name}`);
          return index === boundaryIndex ? boundary.promise : undefined;
        },
      }));
      const lifecycle = new DesktopHostLifecycle({
        startSteps: steps,
        closeAdmission: () => { events.push('freeze'); },
        ordinaryQuit: async () => {
          events.push('ordinary-quit');
          return 'disposed';
        },
        rollback: async () => { events.push('rollback'); },
        exitAfterStartupFailure: () => { events.push('exit:failure'); },
        exitAfterEarlyQuit: () => { events.push('exit:quit'); },
      });

      const startup = lifecycle.start();
      while (!events.includes(`start:${steps[boundaryIndex]!.name}`)) await Promise.resolve();
      const quitting = lifecycle.requestQuit();
      boundary.resolve();
      await Promise.all([startup, quitting]);

      expect(events).not.toContain(`start:${steps[boundaryIndex + 1]?.name}`);
      expect(events.filter((event) => event === 'freeze')).toHaveLength(1);
      expect(lifecycle.phase()).toBe('disposed');
    }
  });

  test('quit reaches every nested Agent boundary before any later producer starts', async () => {
    const boundaryNames = ['threads', 'memory', 'automations'] as const;
    for (const boundaryName of boundaryNames) {
      const boundary = deferred();
      const events: string[] = [];
      const pauseAt = async (name: typeof boundaryNames[number]) => {
        events.push(`agent:${name}`);
        if (name === boundaryName) await boundary.promise;
      };
      const agent = createAgentHostLifecycle({
        memory: {
          initializeMutationIndex: () => { events.push('agent:index'); },
          startWorker: () => pauseAt('memory'),
          stopWorker: async () => undefined,
          closeStore: () => undefined,
        },
        threads: {
          initialize: () => pauseAt('threads'),
          close: async () => undefined,
        },
        automations: {
          start: () => pauseAt('automations'),
          stop: async () => undefined,
          closeStore: () => undefined,
        },
      });
      const lifecycle = new DesktopHostLifecycle({
        startSteps: [
          { name: 'outline-documents', run: () => { events.push('documents'); } },
          {
            name: 'agent',
            run: ({ assertActive }) => agent.initialize({} as DocumentProjection, assertActive),
          },
          { name: 'publication', run: () => { events.push('publication'); } },
        ],
        closeAdmission: () => { events.push('freeze'); },
        ordinaryQuit: async () => {
          events.push('ordinary-quit');
          return 'disposed';
        },
        rollback: async () => undefined,
        exitAfterStartupFailure: () => undefined,
        exitAfterEarlyQuit: () => undefined,
      });

      const startup = lifecycle.start();
      while (!events.includes(`agent:${boundaryName}`)) await Promise.resolve();
      const quitting = lifecycle.requestQuit();
      boundary.resolve();
      await Promise.all([startup, quitting]);

      const startedBoundaries = boundaryName === 'threads' ? ['threads'] : boundaryNames;
      expect(events).toEqual([
        'documents',
        'agent:index',
        ...startedBoundaries.map((name) => `agent:${name}`),
        'freeze',
        'ordinary-quit',
      ]);
      expect(events).not.toContain('publication');
      expect(lifecycle.phase()).toBe('disposed');
    }
  });

  test('Cancel during startup resumes every remaining startup step before reporting started', async () => {
    const boundary = deferred();
    const { events, lifecycle, setQuitOutcome } = createHarness({
      startSteps: [
        { name: 'outline-documents', run: () => { events.push('documents'); } },
        {
          name: 'agent',
          run: async () => {
            events.push('agent');
            await boundary.promise;
          },
        },
        { name: 'publication', run: () => { events.push('publication'); } },
      ],
    });
    setQuitOutcome('cancelled');

    const startup = lifecycle.start();
    while (!events.includes('agent')) await Promise.resolve();
    const quitting = lifecycle.requestQuit();
    boundary.resolve();

    await quitting;
    await startup;
    expect(lifecycle.phase()).toBe('started');
    expect([...lifecycle.completedMilestones()]).toEqual([
      'outline-documents',
      'agent',
      'publication',
    ]);
    expect(events).toEqual([
      'documents',
      'agent',
      'freeze',
      'ordinary-quit',
      'publication',
    ]);
  });

  test('quit before document startup uses rollback without Runtime shutdown', async () => {
    const { events, lifecycle } = createHarness();
    await lifecycle.requestQuit();
    expect(events).toEqual(['freeze', 'rollback:quit-before-start', 'exit:quit']);
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('early rollback failure still settles startup and exits exactly once', async () => {
    const boundary = deferred();
    const events: string[] = [];
    const lifecycle = new DesktopHostLifecycle({
      startSteps: [
        {
          name: 'provider-configuration',
          run: async () => {
            events.push('provider');
            await boundary.promise;
          },
        },
        { name: 'outline-documents', run: () => { events.push('documents'); } },
      ],
      closeAdmission: () => { events.push('freeze'); },
      ordinaryQuit: async () => 'disposed',
      rollback: async (_milestones, cause) => {
        events.push(`rollback:${cause}`);
        throw new Error('early cleanup failed');
      },
      exitAfterStartupFailure: () => undefined,
      exitAfterEarlyQuit: () => { events.push('exit:quit'); },
    });

    const startup = lifecycle.start();
    while (!events.includes('provider')) await Promise.resolve();
    const quitting = lifecycle.requestQuit();
    boundary.resolve();

    await startup;
    await expect(quitting).rejects.toThrow('early cleanup failed');
    expect(lifecycle.phase()).toBe('disposed');
    expect(events).toEqual([
      'provider',
      'freeze',
      'rollback:quit-before-start',
      'exit:quit',
    ]);

    await lifecycle.requestQuit();
    expect(events.filter((event) => event === 'exit:quit')).toHaveLength(1);
  });

  test('startup failure preserves the original error and aggregates rollback failure', async () => {
    const lifecycle = new DesktopHostLifecycle({
      startSteps: [{ name: 'broken', run: () => { throw new Error('startup failed'); } }],
      closeAdmission: () => undefined,
      ordinaryQuit: async () => 'disposed',
      rollback: async () => { throw new Error('rollback failed'); },
      exitAfterStartupFailure: () => undefined,
      exitAfterEarlyQuit: () => undefined,
    });
    const error = await lifecycle.start().catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((entry: Error) => entry.message)).toEqual(['startup failed', 'rollback failed']);
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('startup failure wins a concurrent quit and rolls back once', async () => {
    const boundary = deferred();
    let rollbackCount = 0;
    const lifecycle = new DesktopHostLifecycle({
      startSteps: [{
        name: 'outline-documents',
        run: async () => {
          await boundary.promise;
          throw new Error('startup failed');
        },
      }],
      closeAdmission: () => undefined,
      ordinaryQuit: async () => 'disposed',
      rollback: async () => { rollbackCount += 1; },
      exitAfterStartupFailure: () => undefined,
      exitAfterEarlyQuit: () => undefined,
    });

    const startup = lifecycle.start();
    await Promise.resolve();
    const quitting = lifecycle.requestQuit();
    boundary.resolve();
    await expect(startup).rejects.toThrow('startup failed');
    await quitting;
    expect(rollbackCount).toBe(1);
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('concurrent quit callers share one attempt and Cancel permits a later attempt', async () => {
    const { events, lifecycle, setQuitOutcome } = createHarness();
    await lifecycle.start();
    setQuitOutcome('cancelled');
    const first = lifecycle.requestQuit();
    const second = lifecycle.requestQuit();
    expect(first).toBe(second);
    await first;
    expect(lifecycle.phase()).toBe('started');

    setQuitOutcome('disposed');
    await lifecycle.requestQuit();
    expect(events.filter((event) => event === 'ordinary-quit')).toHaveLength(2);
    expect(events.filter((event) => event === 'freeze')).toHaveLength(2);
    expect(lifecycle.phase()).toBe('disposed');
  });

  test('a reversible quit failure is not cached and a later request can recover', async () => {
    const events: string[] = [];
    let quitAttempts = 0;
    const lifecycle = new DesktopHostLifecycle({
      startSteps: [
        { name: 'outline-documents', run: () => { events.push('documents'); } },
        { name: 'publication', run: () => { events.push('publication'); } },
      ],
      closeAdmission: () => { events.push('freeze'); },
      ordinaryQuit: async () => {
        quitAttempts += 1;
        events.push(`ordinary-quit:${quitAttempts}`);
        if (quitAttempts === 1) throw new Error('unfreeze failed');
        return 'cancelled';
      },
      rollback: async () => undefined,
      exitAfterStartupFailure: () => undefined,
      exitAfterEarlyQuit: () => undefined,
    });
    await lifecycle.start();

    await expect(lifecycle.requestQuit()).rejects.toThrow('unfreeze failed');
    expect(lifecycle.phase()).toBe('quitting');

    await lifecycle.requestQuit();
    expect(lifecycle.phase()).toBe('started');
    expect(events).toEqual([
      'documents',
      'publication',
      'freeze',
      'ordinary-quit:1',
      'freeze',
      'ordinary-quit:2',
    ]);
  });
});
