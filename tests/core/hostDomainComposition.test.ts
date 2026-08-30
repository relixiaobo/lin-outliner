import { describe, expect, test } from 'bun:test';
import type { DocumentProjection, ProjectionSnapshot } from '../../src/core/types';
import {
  assignOnce,
  createAgentHostLifecycle,
  type AgentHostLifecycleDependencies,
  createOutlineDesktopHostLifecycle,
} from '../../src/main/hostDomain/compositionLifecycle';

describe('Host domain composition', () => {
  test('assign-once callbacks reject incomplete and duplicate composition', () => {
    const reference = assignOnce<object>('fixture');
    expect(() => reference.get()).toThrow('fixture is unavailable before Agent Host composition completes.');
    const value = {};
    reference.set(value);
    expect(reference.get()).toBe(value);
    expect(() => reference.set({})).toThrow('fixture is already assigned.');
  });

  test('Agent lifecycle preserves startup and reverse close order', async () => {
    const events: string[] = [];
    const dependencies = {
      memory: {
        initializeMutationIndex: () => events.push('memory:index'),
        startWorker: async () => { events.push('memory:start'); },
        stopWorker: async () => { events.push('memory:stop'); },
        closeStore: () => { events.push('memory:close'); },
      },
      threads: {
        initialize: async () => { events.push('threads:start'); },
        close: async () => { events.push('threads:close'); },
      },
      automations: {
        start: async () => { events.push('automations:start'); },
        stop: async () => { events.push('automations:stop'); },
        closeStore: () => { events.push('automations:close'); },
      },
    } as unknown as AgentHostLifecycleDependencies;
    const lifecycle = createAgentHostLifecycle(dependencies);

    await lifecycle.initialize({} as DocumentProjection);
    await lifecycle.close();

    expect(events).toEqual([
      'memory:index',
      'threads:start',
      'memory:start',
      'automations:start',
      'automations:stop',
      'memory:stop',
      'threads:close',
      'memory:close',
      'automations:close',
    ]);
  });

  test('Outline lifecycle degrades ranking load and keeps explicit close order', async () => {
    const events: string[] = [];
    const reports: string[] = [];
    const ranking = new Map([['node:1', { s: 1, tUpdate: 1 }]]);
    const lifecycle = createOutlineDesktopHostLifecycle({
      documents: {
        init: async () => {
          events.push('documents:start');
          return {} as ProjectionSnapshot;
        },
        replacePersonalAccessRanking: async (entries) => {
          events.push(`ranking:sync:${entries.size}`);
        },
        close: () => { events.push('documents:close'); },
      },
      client: {
        close: () => { events.push('client:close'); },
      },
      nodeAccess: {
        load: async () => {
          events.push('ranking:load');
          throw new Error('unreadable ranking');
        },
        snapshot: () => ranking,
        flushNow: async () => { events.push('ranking:flush'); },
      },
      reportError: (report) => { reports.push(report.code); },
    });

    await lifecycle.initializeDocuments();
    await lifecycle.initializePersonalAccessRanking();
    await lifecycle.flushDerivedState();
    lifecycle.close();

    expect(events).toEqual([
      'documents:start',
      'ranking:load',
      'ranking:sync:1',
      'ranking:flush',
      'client:close',
      'documents:close',
    ]);
    expect(reports).toEqual(['node-access-startup-load']);
  });
});
