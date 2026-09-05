import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentProjection, ProjectionSnapshot } from '../../src/core/types';
import {
  assignOnce,
  createAgentHostLifecycle,
  type AgentHostLifecycleDependencies,
  createOutlineDesktopHostLifecycle,
} from '../../src/main/hostDomain/compositionLifecycle';

describe('Host domain composition', () => {
  test('loads node access beside document initialization and publishes ranking only after both are ready', async () => {
    let releaseDocuments!: () => void;
    let releaseAccess!: () => void;
    const documents = new Promise<void>((resolve) => { releaseDocuments = resolve; });
    const access = new Promise<void>((resolve) => { releaseAccess = resolve; });
    const events: string[] = [];
    const lifecycle = createOutlineDesktopHostLifecycle({
      documents: {
        init: async () => { await documents; return {} as ProjectionSnapshot; },
        replacePersonalAccessRanking: async () => { events.push('ranking:published'); },
        close: () => undefined,
      },
      nodeAccess: {
        load: async () => { events.push('access:loading'); await access; },
        snapshot: () => new Map(),
        flushNow: async () => undefined,
      },
      client: { close: () => undefined },
      reportError: () => undefined,
    });
    const projection = lifecycle.initializeDocuments();
    const ranking = lifecycle.initializePersonalAccessRanking();
    expect(lifecycle.initializePersonalAccessRanking()).toBe(ranking);
    expect(events).toEqual(['access:loading']);
    releaseDocuments();
    await projection;
    expect(events).toEqual(['access:loading']);
    releaseAccess();
    await ranking;
    expect(events).toEqual(['access:loading', 'ranking:published']);
  });

  test('exports narrow capabilities without leaking domain services or runtime maps', () => {
    const mainSource = readFileSync(path.join(import.meta.dir, '../../src/main/main.ts'), 'utf8');
    const desktopHostSource = readFileSync(
      path.join(import.meta.dir, '../../src/main/desktopHost.ts'),
      'utf8',
    );
    const outlineSource = readFileSync(
      path.join(import.meta.dir, '../../src/main/hostDomain/outlineDesktopHost.ts'),
      'utf8',
    );
    const agentSource = readFileSync(
      path.join(import.meta.dir, '../../src/main/hostDomain/agentHost.ts'),
      'utf8',
    );
    const managedSkillsSource = readFileSync(
      path.join(import.meta.dir, '../../src/main/hostDomain/managedSkillsHost.ts'),
      'utf8',
    );

    expect(outlineSource).not.toMatch(/readonly (?:supervisor|client|documents|nodeAccess):/u);
    expect(agentSource).not.toMatch(
      /readonly (?:configurationLoader|configurationWriter|worktree|threadService|automationService|toolRuntime|managedSkills):/u,
    );
    expect(managedSkillsSource).not.toMatch(
      /readonly (?:browserPilot|service|shellEnvironment|primaryRuntime|turnRuntimes|turnRuntimeInitializations):/u,
    );
    expect(managedSkillsSource).toContain('const turnRuntimes = new Map<string, AgentSkillRuntime>();');
    const concreteServiceBindings = [
      'outlineDocumentService',
      'desktopOutlineClient',
      'outlineClientSupervisor',
      'nodeAccessStore',
      'agentConfigurationLoader',
      'agentConfigurationWriter',
      'memoryExtension',
      'automationService',
      'managedSkillService',
      'threadService',
      'toolRuntime',
      'turnSkillRuntimes',
      'turnSkillRuntimeInitializations',
    ].join('|');
    const concreteServicePattern = new RegExp(
        `\\b(?:const|let)\\s+(?:(?:${concreteServiceBindings})\\b|\\{[^}]*\\b(?:${concreteServiceBindings})\\b)`,
        'su',
      );
    expect(mainSource).not.toMatch(concreteServicePattern);
    expect(desktopHostSource).not.toMatch(concreteServicePattern);
    expect(desktopHostSource).toContain('agentHost.threads');
    expect(desktopHostSource).toContain('outlineHost.document');
  });

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

  test('Agent lifecycle stops at each async startup boundary and resumes without duplicate work', async () => {
    const boundaryNames = ['threads:start', 'memory:start', 'automations:start'] as const;
    for (const boundaryName of boundaryNames) {
      let release!: () => void;
      const boundary = new Promise<void>((resolve) => { release = resolve; });
      const events: string[] = [];
      let active = true;
      const pauseAt = async (name: typeof boundaryNames[number]) => {
        events.push(name);
        if (name === boundaryName) await boundary;
      };
      const lifecycle = createAgentHostLifecycle({
        memory: {
          initializeMutationIndex: () => { events.push('memory:index'); },
          startWorker: () => pauseAt('memory:start'),
          stopWorker: async () => undefined,
          closeStore: () => undefined,
        },
        threads: {
          initialize: () => pauseAt('threads:start'),
          close: async () => undefined,
        },
        automations: {
          start: () => pauseAt('automations:start'),
          stop: async () => undefined,
          closeStore: () => undefined,
        },
      });
      const assertActive = () => {
        if (!active) throw new Error('startup ownership lost');
      };

      const interrupted = lifecycle.initialize({} as DocumentProjection, assertActive);
      while (!events.includes(boundaryName)) await Promise.resolve();
      active = false;
      release();
      await expect(interrupted).rejects.toThrow('startup ownership lost');

      const startedBoundaries = boundaryName === 'threads:start' ? ['threads:start'] : boundaryNames;
      expect(events).toEqual(['memory:index', ...startedBoundaries]);

      active = true;
      await lifecycle.initialize({} as DocumentProjection, assertActive);
      expect(events).toEqual(['memory:index', ...boundaryNames]);
    }
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
      'documents:start',
      'ranking:sync:1',
      'ranking:flush',
      'client:close',
      'documents:close',
    ]);
    expect(reports).toEqual(['node-access-startup-load']);
  });
});
