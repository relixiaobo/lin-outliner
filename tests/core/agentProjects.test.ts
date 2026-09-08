import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProjectManageRequest, type Project } from '../../src/core/agent/project';
import { decodeAutomationResponse, EMPTY_AUTOMATION_CONFIGURATION } from '../../src/core/agent/automation';
import type { Thread } from '../../src/core/agent/protocol';
import { defaultEffectiveThreadConfiguration } from '../../src/main/agent/AgentConfigurationLoader';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ProjectService, type ReviewProjectChange } from '../../src/main/agent/projects/ProjectService';
import { projectAutomationLifecycle } from '../../src/main/agent/projects/projectAutomationLifecycle';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { AutomationScheduler } from '../../src/main/agent/automations/AutomationScheduler';
import type { AutomationDispatcher } from '../../src/main/agent/automations/AutomationDispatcher';
import { createProjectTools } from '../../src/main/agent/projects/projectTools';
import { modelToolContract } from '../../src/core/agent/tools';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';
import { uuidV7 } from '../../src/main/agent/uuid';

const closers: Array<() => void> = [];
const roots: string[] = [];
afterEach(async () => {
  closers.splice(0).reverse().forEach((close) => close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-project-'));
  roots.push(root);
  return realpath(root);
}
function catalog(path = ':memory:', review?: ReviewProjectChange) {
  const db = new Database(path);
  const metadata = new ThreadMetadataStore(path, db as unknown as SqliteDatabase);
  closers.push(() => metadata.close());
  const projects = metadata.projects;
  const service = new ProjectService(projects, (id) => metadata.read(id)?.thread ?? null, review);
  function chat(overrides: Partial<Thread> = {}, project?: Project) {
    const thread: Thread = { id: uuidV7(), sessionId: uuidV7(), parentThreadId: null, forkedFromId: null,
      name: 'Chat', preview: '', ephemeral: false, source: 'app', threadSource: 'user', modelProvider: 'openai',
      configurationSource: { kind: 'user' }, createdAt: 1, updatedAt: 1, status: { type: 'idle' }, historyMode: 'paginated', ...overrides };
    const record = { thread, nameOrigin: 'manual' as const, archived: false,
      configuration: defaultEffectiveThreadConfiguration(), toolCeiling: null };
    if (thread.parentThreadId) metadata.createChild(record, { sessionId: thread.sessionId, parentThreadId: thread.parentThreadId,
      childThreadId: thread.id, taskPath: `/root/${thread.id}`, createdAt: 1 });
    else metadata.create(record, project ? { projectId: project.id, expectedRevision: project.revision } : undefined);
    return thread;
  }
  return { db, metadata, projects, service, chat };
}
function deletion(project: Project) { return { operation: 'delete', projectId: project.id, expectedRevision: project.revision } as const; }

function automationHarness(host: ReturnType<typeof catalog>, recover: () => Promise<void> = async () => {}) {
  const db = new Database(':memory:');
  const store = new AutomationStore(':memory:', db as unknown as SqliteDatabase);
  closers.push(() => store.close());
  store.bindProjectResolver((id) => host.projects.require(id));
  const dispatcher = { recoverPendingRuns: recover } as unknown as AutomationDispatcher;
  const scheduler = new AutomationScheduler({ store, dispatcher, setTimer: () => 1, clearTimer: () => {} });
  const lifecycle = projectAutomationLifecycle(store, scheduler, dispatcher);
  host.service.attachAutomation(lifecycle);
  const now = Date.parse('2026-07-24T08:00:00Z');
  function definition(project: Project, status: 'active' | 'paused' = 'active') {
    return store.create({ name: 'Project review', prompt: 'Review the files', status,
      schedule: { rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=DAILY;COUNT=1', timezone: 'UTC' },
      destination: { kind: 'standalone' }, configuration: EMPTY_AUTOMATION_CONFIGURATION,
      contextHints: [{ source: { kind: 'project', projectId: project.id }, executionMode: 'local' }] }, now);
  }
  return { store, lifecycle, scheduler, definition, now };
}

describe('Project catalog lifecycle', () => {
  test('rejects open protocol fields and inconsistent binding revisions', () => {
    expect(() => decodeProjectManageRequest({ operation: 'create', name: 'Example', rootHint: null, cwd: '/tmp' })).toThrow();
    expect(() => decodeProjectManageRequest({ operation: 'create', name: 'Example', rootHint: 'relative' })).toThrow('absolute');
    expect(() => decodeProjectManageRequest({ operation: 'bind', threadId: uuidV7(), projectId: null,
      expectedRevision: 1, expectedMembershipRevision: 0 })).toThrow('revision');
  });

  test('plain Chats stay ungrouped and explicit initial membership commits with creation', () => {
    const host = catalog();
    const project = host.projects.create('Example', null, 1);
    const plain = host.chat();
    expect(host.projects.membership(plain.id)).toEqual({ threadId: plain.id, projectId: null, revision: 0 });
    const grouped = host.chat({}, project);
    expect(host.projects.membership(grouped.id).projectId).toBe(project.id);
    expect(host.metadata.require(grouped.id).thread).not.toHaveProperty('cwd');
    expect(host.metadata.require(grouped.id).thread.configurationSource).toEqual({ kind: 'user' });
    host.projects.update(project.id, 1, 'Renamed', null, 2);
    const rejectedId = uuidV7();
    expect(() => host.chat({ id: rejectedId }, project)).toThrow('changed');
    expect(host.metadata.read(rejectedId)).toBeNull();
    expect(host.projects.membership(rejectedId).revision).toBe(0);
  });

  test('inherits forks and hidden children, and rebinds complete canonical lineage', async () => {
    const host = catalog();
    const first = host.projects.create('First', null, 1);
    const second = host.projects.create('Second', null, 2);
    const root = host.chat({}, first);
    const fork = host.chat({ forkedFromId: root.id });
    const child = host.chat({ parentThreadId: fork.id, sessionId: fork.sessionId, threadSource: 'delegation' });
    const hidden = host.chat({ parentThreadId: child.id, sessionId: child.sessionId, threadSource: 'memory_consolidation' });
    for (const thread of [fork, child, hidden]) expect(host.projects.membership(thread.id).projectId).toBe(first.id);
    host.db.prepare('DELETE FROM project_memberships WHERE thread_id = ?').run(child.id);
    await host.service.manage({ operation: 'bind', threadId: root.id, projectId: second.id,
      expectedRevision: second.revision, expectedMembershipRevision: 1 });
    for (const thread of [root, fork, child, hidden]) expect(host.projects.membership(thread.id).projectId).toBe(second.id);
    await expect(host.service.manage({ operation: 'bind', threadId: root.id, projectId: null,
      expectedRevision: null, expectedMembershipRevision: 1 })).rejects.toThrow('membership changed');
    await expect(host.service.manage({ operation: 'bind', threadId: hidden.id, projectId: null,
      expectedRevision: null, expectedMembershipRevision: 1 })).rejects.toThrow('persistent user Chat');
  });

  test('shows the canonical path before confirmation and cancellation writes nothing', async () => {
    const root = await directory();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias);
    let reviewed = false;
    const host = catalog(':memory:', async (review) => {
      expect(review.request).toEqual({ operation: 'create', name: 'Example', rootHint: root });
      reviewed = true;
      return false;
    });
    const result = await host.service.manage({ operation: 'create', name: ' Example ', rootHint: alias }, 'agent');
    expect(reviewed).toBe(true);
    expect(result.outcome).toBe('cancelled');
    expect(host.projects.list()).toHaveLength(0);
    const created = await host.service.manage({ operation: 'create', name: 'Example', rootHint: alias });
    expect(created.project?.rootHint).toBe(root);
  });

  test('an approved proposal cannot overwrite a Project changed while confirmation was open', async () => {
    const host = catalog(':memory:', async () => {
      host.projects.update(project.id, 1, 'User edit', null, 2);
      return true;
    });
    const project = host.projects.create('Original', null, 1);
    await expect(host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: 1,
      name: 'Agent edit', rootHint: null }, 'agent')).rejects.toThrow('changed');
    expect(host.projects.require(project.id).name).toBe('User edit');
  });

  test('an aborted approved proposal cannot persist a change', async () => {
    const controller = new AbortController();
    const host = catalog(':memory:', async () => { controller.abort(); return true; });
    await expect(host.service.manage({ operation: 'create', name: 'Example', rootHint: null }, 'agent', controller.signal)).rejects.toThrow();
    expect(host.projects.list()).toHaveLength(0);
  });

  test('deletion traverses missing membership rows and preserves unrelated membership and user files', async () => {
    const host = catalog();
    const rootPath = await directory();
    await writeFile(join(rootPath, 'receipt.txt'), 'immutable user content');
    const project = host.projects.create('Example', rootPath, 1);
    const other = host.projects.create('Other', null, 2);
    const root = host.chat({}, project);
    const fork = host.chat({ forkedFromId: root.id });
    const hidden = host.chat({ parentThreadId: fork.id, sessionId: fork.sessionId, threadSource: 'delegation' });
    const independent = host.chat({ forkedFromId: root.id }, other);
    host.db.prepare('DELETE FROM project_memberships WHERE thread_id = ?').run(fork.id);
    const result = await host.service.manage(deletion(project));
    expect(result.affectedThreadIds).toContain(hidden.id);
    expect(host.projects.read(project.id)).toBeNull();
    for (const thread of [root, fork, hidden]) {
      expect(host.projects.membership(thread.id).projectId).toBeNull();
      expect(host.metadata.require(thread.id).thread).toEqual(thread);
    }
    expect(host.projects.membership(independent.id).projectId).toBe(other.id);
    expect(await readFile(join(rootPath, 'receipt.txt'), 'utf8')).toBe('immutable user content');
  });

  test('the durable deletion fence blocks admission and recovery completes it before scheduling', async () => {
    const path = join(await directory(), 'threads.sqlite');
    const host = catalog(path);
    const project = host.projects.create('Example', null, 1);
    const root = host.chat({}, project);
    host.projects.beginDeletion(project.id, 1);
    expect(() => host.chat({}, project)).toThrow('being deleted');
    const concurrentFork = host.chat({ forkedFromId: root.id });
    expect(host.projects.membership(concurrentFork.id).projectId).toBeNull();
    closers.pop()!();
    const reopened = catalog(path);
    expect(reopened.projects.deletionIntents()).toEqual([project.id]);
    await reopened.service.initialize();
    expect(reopened.projects.read(project.id, true)).toBeNull();
    expect(reopened.projects.membership(root.id).projectId).toBeNull();
    await reopened.service.initialize();
    expect(reopened.metadata.require(root.id).thread).toEqual(root);
  });

  test.each(['active', 'paused'] as const)('%s Project definitions refuse deletion and clear its fence', async (status) => {
    const host = catalog();
    const project = host.projects.create('Example', await directory(), 1);
    const harness = automationHarness(host);
    harness.definition(project, status);
    await expect(host.service.manage(deletion(project))).rejects.toThrow('Project review');
    expect(host.projects.require(project.id)).toEqual(project);
    expect(host.projects.deletionIntents()).toEqual([]);
    host.projects.beginDeletion(project.id, project.revision);
    await host.service.initialize();
    expect(host.projects.require(project.id)).toEqual(project);
  });

  test('completed definitions still block on unaccepted claims and reconcile accepted claims before deletion', async () => {
    const host = catalog();
    const project = host.projects.create('Example', await directory(), 1);
    let accepted = false;
    let reconciliations = 0;
    const harness = automationHarness(host, async () => {
      reconciliations += 1;
      if (accepted) harness.store.markDispatched(run.id, run.threadId!, uuidV7(), harness.now + 1);
    });
    const automation = harness.definition(project);
    const due = harness.now + 3_600_000;
    const claim = harness.store.claimDueBatch({ automation, binding: automation.contextHints[0]!,
      occurrences: [due], expectedEvaluatedThrough: harness.now - 1, evaluatedThrough: due,
      truncated: false, now: due });
    const run = claim.claimed!;
    expect(harness.store.completeIfExhausted(automation.id, automation.revision, due)?.status).toBe('completed');
    await expect(host.service.manage(deletion(project))).rejects.toThrow(run.id);
    accepted = true;
    await host.service.manage(deletion(project));
    expect(reconciliations).toBe(2);
    const history = harness.store.readRun(run.id)!;
    expect(history.state).toBe('dispatched');
    expect(history.snapshot.projectSnapshot).toEqual(project);
    expect(decodeAutomationResponse('runs', { data: [history] }).data[0]).toEqual(history);
    expect(harness.store.read(automation.id)?.contextHints[0]?.source.projectId).toBe(project.id);
  });

  test('claims freeze root, display name, and revision while later claims use the edited Project', async () => {
    const host = catalog();
    const project = host.projects.create('Before', await directory(), 1);
    const harness = automationHarness(host);
    const automation = harness.definition(project);
    const first = harness.store.claimNow(automation, automation.contextHints[0]!, harness.now);
    const edited = host.projects.update(project.id, 1, 'After', await directory(), 2);
    const second = harness.store.claimNow(automation, automation.contextHints[0]!, harness.now + 1);
    expect(harness.store.readRun(first.id)?.snapshot.projectSnapshot).toEqual(project);
    expect(second.snapshot.projectSnapshot).toEqual(edited);
    expect(() => decodeAutomationResponse('runs', { data: [{ ...first, snapshot: { ...first.snapshot,
      projectSnapshot: { ...project, id: uuidV7() } } }] })).toThrow();
  });

  test('Project tools authorize before confirmation and return bounded schema-valid model data', async () => {
    let confirmations = 0;
    let allowed = false;
    const host = catalog(':memory:', async () => { confirmations += 1; return true; });
    const root = host.chat();
    const tools = createProjectTools(host.service, root.id, async () => { if (!allowed) throw new Error('blocked'); });
    const manage = tools.find((tool) => tool.name === 'project_manage')!;
    const input = { request: { operation: 'create', name: 'From the Agent', rootHint: null } };
    await expect(manage.execute('proposal', input)).rejects.toThrow('blocked');
    expect(confirmations).toBe(0);
    allowed = true;
    const saved = await manage.execute('proposal', input);
    expect(confirmations).toBe(1);
    expect(compileToolParameters(modelToolContract('project_manage')!.outputSchema as never)
      .Check((saved.details as { data: unknown }).data)).toBe(true);
    for (let index = 0; index < 50; index += 1) host.projects.create(`Project ${index}`, null, index + 1);
    const inspect = tools.find((tool) => tool.name === 'project_inspect')!;
    const page = await inspect.execute('inspect', {});
    const data = (page.details as { data: { projects: unknown[]; nextOffset: number } }).data;
    expect(data.projects).toHaveLength(50);
    expect(data.nextOffset).toBe(50);
    expect(compileToolParameters(modelToolContract('project_inspect')!.outputSchema as never).Check(data)).toBe(true);
    expect((await inspect.execute('inspect-more', { offset: 50 })).details).toMatchObject({
      data: { totalProjects: 51, nextOffset: null },
    });
  });

  test('Project deletion waits for already-admitted hint writes under the scheduler lock', async () => {
    const host = catalog();
    const project = host.projects.create('Example', await directory(), 1);
    const harness = automationHarness(host);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const write = harness.scheduler.runExclusive(async () => {
      enter();
      await blocked;
      harness.definition(project);
    });
    await entered;
    const removal = host.service.manage(deletion(project));
    const outcome = removal.then(() => null, (error: Error) => error);
    expect(host.projects.deletionIntents()).toEqual([]);
    release();
    await write;
    expect((await outcome)?.message).toContain('Project review');
    expect(host.projects.require(project.id)).toEqual(project);
  });

  test('a crash during reconciliation preserves the durable fence until successful recovery', async () => {
    const host = catalog();
    const project = host.projects.create('Example', null, 1);
    let crash = true;
    host.service.attachAutomation({ runExclusive: (operation) => operation(), references: () => [],
      reconcileAcceptedClaims: async () => { if (crash) throw new Error('interrupted'); } });
    await expect(host.service.manage(deletion(project))).rejects.toThrow('interrupted');
    expect(host.projects.deletionIntents()).toEqual([project.id]);
    crash = false;
    await host.service.initialize();
    expect(host.projects.read(project.id, true)).toBeNull();
  });
});
