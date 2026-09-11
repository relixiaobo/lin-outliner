import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import { mkdtemp, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProjectManageRequest, type Project } from '../../src/core/agent/project';
import { decodeAutomationResponse, EMPTY_AUTOMATION_CONFIGURATION } from '../../src/core/agent/automation';
import type { Thread } from '../../src/core/agent/protocol';
import { defaultEffectiveThreadConfiguration } from '../../src/main/agent/AgentConfigurationLoader';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ProjectService } from '../../src/main/agent/projects/ProjectService';
import { projectAutomationLifecycle } from '../../src/main/agent/projects/projectAutomationLifecycle';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { AutomationScheduler } from '../../src/main/agent/automations/AutomationScheduler';
import type { AutomationDispatcher } from '../../src/main/agent/automations/AutomationDispatcher';
import { modelToolContract } from '../../src/core/agent/tools';
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
function catalog(path = ':memory:') {
  const db = new Database(path);
  const metadata = new ThreadMetadataStore(path, db as unknown as SqliteDatabase);
  closers.push(() => metadata.close());
  const projects = metadata.projects;
  const service = new ProjectService(projects, (id) => metadata.read(id)?.thread ?? null);
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
function createProject(host: ReturnType<typeof catalog>, name: string, path: string | null, now: number) {
  return host.projects.create(name, path ? [path] : [], path, now);
}
function updateProject(host: ReturnType<typeof catalog>, id: string, revision: number, name: string, path: string | null, now: number) {
  return host.projects.update(id, revision, name, path ? [path] : [], path, now);
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
    expect(() => decodeProjectManageRequest({ operation: 'create', name: 'Example', folders: [], primaryFolder: null, cwd: '/tmp' })).toThrow();
    expect(() => decodeProjectManageRequest({ operation: 'create', name: 'Example', folders: ['relative'], primaryFolder: 'relative' })).toThrow('absolute');
    expect(() => decodeProjectManageRequest({ operation: 'bind', threadId: uuidV7(), projectId: null,
      expectedRevision: 1, expectedMembershipRevision: 0 })).toThrow('revision');
  });

  test('plain Chats stay ungrouped and explicit initial membership commits with creation', () => {
    const host = catalog();
    const project = createProject(host, 'Example', null, 1);
    const plain = host.chat();
    expect(host.projects.membership(plain.id)).toEqual({ threadId: plain.id, projectId: null, revision: 0 });
    const grouped = host.chat({}, project);
    expect(host.projects.membership(grouped.id).projectId).toBe(project.id);
    expect(host.metadata.require(grouped.id).thread).not.toHaveProperty('cwd');
    expect(host.metadata.require(grouped.id).thread.configurationSource).toEqual({ kind: 'user' });
    updateProject(host, project.id, 1, 'Renamed', null, 2);
    const rejectedId = uuidV7();
    expect(() => host.chat({ id: rejectedId }, project)).toThrow('changed');
    expect(host.metadata.read(rejectedId)).toBeNull();
    expect(host.projects.membership(rejectedId).revision).toBe(0);
  });

  test('inherits forks and hidden children, and rebinds complete canonical lineage', async () => {
    const host = catalog();
    const first = createProject(host, 'First', null, 1);
    const second = createProject(host, 'Second', null, 2);
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

  test.each(['create', 'update'] as const)(
    'cancelling a %s during directory revalidation writes nothing',
    async (operation) => {
      const root = await directory();
      const host = catalog();
      const original = createProject(host, 'Original', root, 1);
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      const revalidating = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const originalStat = fs.stat;
      let validations = 0;
      const stat = spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
        const result = await originalStat(...args);
        if (++validations === 2) { entered(); await blocked; }
        return result;
      });
      try {
        const request = operation === 'create'
          ? { operation, name: 'User edit', folders: [root], primaryFolder: root }
          : { operation, projectId: original.id, expectedRevision: original.revision, name: 'User edit', folders: [root], primaryFolder: root };
        const pending = host.service.manage(request, controller.signal);
        await revalidating;
        controller.abort(new Error('Operation cancelled during directory validation'));
        release();
        await expect(pending).rejects.toThrow('Operation cancelled during directory validation');
        expect(host.projects.list()).toEqual([original]);
      } finally {
        release();
        stat.mockRestore();
      }
    },
  );

  test('deletion traverses missing membership rows and preserves unrelated membership and user files', async () => {
    const host = catalog();
    const rootPath = await directory();
    await writeFile(join(rootPath, 'receipt.txt'), 'immutable user content');
    const project = createProject(host, 'Example', rootPath, 1);
    const other = createProject(host, 'Other', null, 2);
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
    const project = createProject(host, 'Example', null, 1);
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
    const project = createProject(host, 'Example', await directory(), 1);
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
    const project = createProject(host, 'Example', await directory(), 1);
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
    const project = createProject(host, 'Before', await directory(), 1);
    const harness = automationHarness(host);
    const automation = harness.definition(project);
    const first = harness.store.claimNow(automation, automation.contextHints[0]!, harness.now);
    const edited = updateProject(host, project.id, 1, 'After', await directory(), 2);
    const second = harness.store.claimNow(automation, automation.contextHints[0]!, harness.now + 1);
    expect(harness.store.readRun(first.id)?.snapshot.projectSnapshot).toEqual(project);
    expect(second.snapshot.projectSnapshot).toEqual(edited);
    expect(() => decodeAutomationResponse('runs', { data: [{ ...first, snapshot: { ...first.snapshot,
      projectSnapshot: { ...project, id: uuidV7() } } }] })).toThrow();
  });

  test('Project management stays available to the UI without model tools', async () => {
    expect(modelToolContract('project_inspect')).toBeNull();
    expect(modelToolContract('project_manage')).toBeNull();
    const host = catalog();
    const root = await directory();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias);
    const created = await host.service.manage({ operation: 'create', name: ' Example ', folders: [alias], primaryFolder: alias });
    expect(created.project?.primaryFolder).toBe(root);
    const project = created.project!;
    const edited = await host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: project.revision,
      name: 'Edited', folders: [], primaryFolder: null });
    await expect(host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: project.revision,
      name: 'Stale edit', folders: [], primaryFolder: null })).rejects.toThrow('changed');
    expect((await host.service.inspect({})).projects).toEqual([edited.project!]);
  });

  test('Project deletion waits for already-admitted hint writes under the scheduler lock', async () => {
    const host = catalog();
    const project = createProject(host, 'Example', await directory(), 1);
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
    const project = createProject(host, 'Example', null, 1);
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

describe('Conversation work folders', () => {
  test('new chats and forks copy folders while moves, primary edits and deletion preserve independent defaults', async () => {
    const host = catalog();
    const a = await directory(), b = await directory();
    const project = (await host.service.manage({ operation: 'create', name: 'Sources', folders: [a, b], primaryFolder: a })).project!;
    const first = host.chat({}, project);
    const second = host.chat({}, project);
    await host.service.manage({ operation: 'setWorkFolder', threadId: first.id, path: b, expectedRevision: 1 });
    const fork = host.chat({ forkedFromId: first.id });
    const child = host.chat({ parentThreadId: first.id, sessionId: first.sessionId, threadSource: 'delegation' });
    expect(host.projects.workFolder(fork.id).path).toBe(b);
    expect(host.projects.workFolder(child.id).path).toBeNull();
    const edited = (await host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: 1,
      name: 'Renamed', folders: [a, b], primaryFolder: b })).project!;
    expect(host.projects.workFolder(second.id).path).toBe(a);
    await host.service.manage({ operation: 'setWorkFolder', threadId: first.id, path: null, expectedRevision: 2 });
    expect(host.projects.workFolder(fork.id).path).toBe(b);
    await host.service.manage(deletion(edited));
    expect(host.projects.workFolder(fork.id).path).toBe(b);
    expect(host.projects.workFolder(second.id).path).toBe(a);
    expect(host.projects.workFolder(first.id).path).toBeNull();
    expect(host.metadata.require(first.id).configuration).toEqual(defaultEffectiveThreadConfiguration());
  });

  test('a folder-less Project and a fork of an unset chat keep application-default identity', async () => {
    const host = catalog();
    const project = createProject(host, 'Organization', null, 1);
    const chat = host.chat({}, project);
    const fork = host.chat({ forkedFromId: chat.id });
    expect(host.projects.workFolder(chat.id)).toMatchObject({ path: null, revision: 1 });
    expect(host.projects.workFolder(fork.id)).toMatchObject({ path: null, revision: 1 });
    const view = await host.service.inspect({ threadIds: [chat.id, fork.id] });
    expect(view.applicationDefault.available).toBe(true);
    expect(view.memberships.every((entry) => entry.projectId === project.id)).toBe(true);
  });

  test('concurrent folder updates conflict and combined selection writes neither setting on a stale folder revision', async () => {
    const host = catalog();
    const chat = host.chat();
    const a = await directory(), b = await directory();
    const project = createProject(host, 'Project', a, 1);
    const results = await Promise.allSettled([a, b].map((path) => host.service.manage({ operation: 'setWorkFolder', threadId: chat.id, path, expectedRevision: 0 })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const accepted = host.projects.workFolder(chat.id);
    await expect(host.service.manage({ operation: 'bind', threadId: chat.id, projectId: project.id, expectedRevision: 1,
      expectedMembershipRevision: 0, workFolder: { path: a, expectedRevision: 0 } })).rejects.toThrow('changed');
    expect(host.projects.membership(chat.id).projectId).toBeNull();
    expect(host.projects.workFolder(chat.id)).toEqual(accepted);
    await host.service.manage({ operation: 'bind', threadId: chat.id, projectId: project.id, expectedRevision: 1,
      expectedMembershipRevision: 0, workFolder: { path: a, expectedRevision: accepted.revision } });
    expect(host.projects.membership(chat.id).projectId).toBe(project.id);
    expect(host.projects.workFolder(chat.id).path).toBe(a);
    await host.service.manage({ operation: 'bind', threadId: chat.id, projectId: null, expectedRevision: null, expectedMembershipRevision: 1 });
    expect(host.projects.workFolder(chat.id).path).toBe(a);
  });

  test('canonical folder identity, primary selection and unavailable secondary references are truthful', async () => {
    const host = catalog();
    const a = await directory(), b = await directory();
    const alias = join(await directory(), 'alias'); await symlink(a, alias);
    await expect(host.service.manage({ operation: 'create', name: 'Duplicate', folders: [a, alias], primaryFolder: a })).rejects.toThrow('Duplicate');
    expect(() => decodeProjectManageRequest({ operation: 'create', name: 'No primary', folders: [a], primaryFolder: null })).toThrow('primary');
    const project = (await host.service.manage({ operation: 'create', name: 'Sources', folders: [alias, b], primaryFolder: alias })).project!;
    expect(project.folders).toEqual([a, b]);
    const chat = host.chat({}, project);
    await rm(b, { recursive: true });
    await host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: 1,
      name: 'Renamed', folders: [a, b], primaryFolder: a });
    const view = await host.service.inspect({ threadIds: [chat.id] });
    expect(view.unavailableFolders).toContain(b);
    expect(view.workFolders[0]?.path).toBe(a);
    await rm(a, { recursive: true });
    expect((await host.service.inspect({ threadIds: [chat.id] })).unavailableFolders).toContain(a);
    await host.service.manage({ operation: 'setWorkFolder', threadId: chat.id, path: null, expectedRevision: 1 });
    expect(host.projects.membership(chat.id).projectId).toBe(project.id);
  });

  test('native proposal cancellation and directory replacement commit nothing', async () => {
    const host = catalog();
    const root = await directory();
    const path = join(root, 'source'); await fs.mkdir(path);
    const request = { operation: 'create', name: 'Proposal', folders: [path], primaryFolder: path };
    await expect(host.service.manage(request, undefined, async () => false)).rejects.toThrow('cancelled');
    await expect(host.service.manage(request, undefined, async () => {
      await fs.rename(path, join(root, 'original')); await fs.mkdir(path); return true;
    })).rejects.toThrow('Directory changed');
    expect(host.projects.list()).toEqual([]);
  });

  test('saved folders and operation receipts survive reopening without duplicate creation', async () => {
    const root = await directory();
    const path = join(root, 'threads.sqlite');
    const host = catalog(path);
    const chat = host.chat();
    const request = { operation: 'create', name: 'Once', folders: [root], primaryFolder: root };
    const receipt = { sourceThreadId: chat.id, operationId: 'create-once', digest: 'exact-request' };
    const first = await host.service.manage(request, undefined, undefined, receipt);
    expect(await host.service.manage(request, undefined, undefined, receipt)).toEqual(first);
    await host.service.manage({ operation: 'setWorkFolder', threadId: chat.id, path: root, expectedRevision: 0 });
    closers.pop()!();
    const restored = catalog(path);
    expect(restored.projects.workFolder(chat.id)).toEqual({ threadId: chat.id, path: root, revision: 1 });
    expect(restored.projects.receipt(chat.id, 'create-once', 'exact-request')).toEqual(first);
    expect(restored.projects.list()).toHaveLength(1);
    await expect(restored.service.manage(request, undefined, undefined, { ...receipt, digest: 'different' })).rejects.toThrow('different request');
  });

  test('deletion recovery records the exact committed receipt after an interrupted reconciliation', async () => {
    const host = catalog();
    const chat = host.chat();
    const project = createProject(host, 'Delete once', null, 1);
    let interrupted = true;
    host.service.attachAutomation({ runExclusive: (operation) => operation(), references: () => [],
      reconcileAcceptedClaims: async () => { if (interrupted) throw new Error('interrupted'); } });
    const receipt = { sourceThreadId: chat.id, operationId: 'delete-once', digest: 'exact-delete' };
    await expect(host.service.manage(deletion(project), undefined, undefined, receipt)).rejects.toThrow('interrupted');
    expect(host.projects.receipt(chat.id, receipt.operationId)).toBeNull();
    expect(host.projects.receiptPending(chat.id, receipt.operationId)).toBe(true);
    interrupted = false;
    await host.service.initialize();
    expect(host.projects.receipt(chat.id, receipt.operationId)).toMatchObject({ outcome: 'applied', project: null });
    expect(host.projects.receiptPending(chat.id, receipt.operationId)).toBe(false);
    expect(await host.service.manage(deletion(project), undefined, undefined, receipt)).toMatchObject({ outcome: 'applied' });
  });
});

describe('invocation-bound Project operations', () => {
  test('paginates the catalog without dropping the selected Project and rejects a changed cursor', async () => {
    const { ProjectCliService } = await import('../../src/main/agent/projects/ProjectCliService');
    const host = catalog(), chat = host.chat();
    let selected!: Project;
    for (let index = 0; index < 51; index++) selected = createProject(host, `Project ${String(index).padStart(2, '0')}`, null, index + 1);
    host.projects.bind(chat.id, selected.id, 1, 0);
    const cli = new ProjectCliService(host.service, async () => {}, async () => true);
    const execute = (input: unknown) => cli.execute({
      admission: { stdin: JSON.stringify(input), source: { rootThreadId: chat.id } }, signal: new AbortController().signal,
    } as Parameters<typeof cli.execute>[0]) as Promise<any>;
    const first = await execute({ action: 'inspect' });
    expect(first.projects).toHaveLength(50);
    expect(first.selectedProject.id).toBe(selected.id);
    const second = await execute({ action: 'inspect', offset: first.nextOffset, catalogRevision: first.catalogRevision });
    expect(second.projects.map((project: Project) => project.id)).toEqual([selected.id]);
    expect(second.nextOffset).toBeNull();
    createProject(host, 'New entry', null, 100);
    await expect(execute({ action: 'inspect', offset: 50, catalogRevision: first.catalogRevision })).rejects.toThrow('catalog changed');
  });

  test('rechecks current authority immediately before folder-only commits and cancels native proposals', async () => {
    const { ProjectCliService } = await import('../../src/main/agent/projects/ProjectCliService');
    const host = catalog(), chat = host.chat();
    let checks = 0;
    const signal = new AbortController();
    const cli = new ProjectCliService(host.service, async () => {
      if (++checks === 2) throw new Error('authority revoked');
    }, async () => { signal.abort(); return true; });
    const execute = (input: unknown) => cli.execute({
      admission: { stdin: JSON.stringify(input), source: { rootThreadId: chat.id } }, signal: signal.signal,
    } as Parameters<typeof cli.execute>[0]);
    await expect(execute({ action: 'manage', operationId: 'folder-revoked', request: {
      operation: 'setWorkFolder', threadId: chat.id, path: await directory(), expectedRevision: 0,
    } })).rejects.toThrow('authority revoked');
    expect(host.projects.workFolder(chat.id)).toMatchObject({ path: null, revision: 0 });
    expect(await execute({ action: 'receipt', operationId: 'folder-revoked' })).toEqual({ outcome: 'not_committed' });
    await expect(execute({ action: 'manage', operationId: 'cancelled', request: {
      operation: 'create', name: 'Cancelled', folders: [], primaryFolder: null,
    } })).rejects.toThrow();
    expect(host.projects.list()).toEqual([]);
  });

  test('rejects a revision changed while the proposal is open instead of overwriting the newer Project', async () => {
    const host = catalog();
    const project = createProject(host, 'Original', null, 1);
    await expect(host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: 1,
      name: 'Stale proposal', folders: [], primaryFolder: null,
    }, undefined, async () => {
      await host.service.manage({ operation: 'update', projectId: project.id, expectedRevision: 1,
        name: 'Newer UI edit', folders: [], primaryFolder: null });
      return true;
    })).rejects.toThrow('Project changed');
    expect(host.projects.require(project.id)).toMatchObject({ name: 'Newer UI edit', revision: 2 });
  });
});
