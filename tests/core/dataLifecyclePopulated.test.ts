import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedPopulatedDataFixture } from '../fixtures/dataLifecycle';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { DataBackupStore } from '../../src/main/dataLifecycle/BackupStore';
import { DataOperationJournal, type DataOperation } from '../../src/main/dataLifecycle/OperationJournal';
import { DataRestoreSession } from '../../src/main/dataLifecycle/RestoreSession';
import { RestoredExecutionFence } from '../../src/main/dataLifecycle/ExecutionFence';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { AutomationDispatcher } from '../../src/main/agent/automations/AutomationDispatcher';
import { MemoryControlStore } from '../../src/main/agent/extensions/memory/MemoryControlStore';
import { AgentResourceStore } from '../../src/main/agent/persistence/AgentResourceStore';
import { assertTaskDataAdmission } from '../../src/main/dataLifecycle/taskAdmission';
import type { ToolTaskFinalReceipt } from '../../src/main/agent/tasks/toolTaskTypes';
import { WorkspaceTransactionLog } from '../../src/outline/runtime/storage';

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), 'tenon-populated-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('populated data restoration', () => {
  test('preserves all owner data while an older pending request never regains execution authority', async () => {
    const userData = await root(); const external = await root();
    const fixture = await seedPopulatedDataFixture(userData);
    const registry = new DataStoreRegistry(); const backups = new DataBackupStore(userData, registry);
    const backup = await backups.create('0.8.0');
    const database = openLifecycleDatabase(join(userData, 'agent/goals.sqlite'), false);
    const tasks = new ToolTaskStore(database);
    const pending = tasks.read(fixture.taskId)!;
    await writeFile(join(external, 'effect.txt'), 'This external effect already happened.');
    tasks.settleArtifacts(pending.taskId, { artifacts: [], warnings: [] }, Date.now());
    const unsigned: Omit<ToolTaskFinalReceipt, 'receiptDigest'> = { version: 3, taskId: pending.taskId, nonce: pending.nonce,
      isolation: { ...pending.isolation, state: 'unsandboxed' }, state: 'succeeded', exitCode: 0, signal: null, reason: 'fixture_completed', error: null,
      supervisorPid: null, childPid: null, startedAt: pending.startedAt, quiescedAt: Date.now(), stdoutBytes: 0, stderrBytes: 0,
      preparedResultDigest: null, preparedResultBytes: 0 };
    tasks.commitTerminal(pending.taskId, { ...unsigned, receiptDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }, Date.now());
    database.close();
    const journal = new DataOperationJournal(userData);
    const operation: DataOperation = { version: 1, id: randomUUID(), kind: 'restore', phase: 'preparing', createdAt: Date.now(), backupId: randomUUID(),
      sourceBackupId: backup.id, completedRoots: [], generation: randomUUID(), targetDigest: registry.contractDigest(), applicationVersion: '0.8.0' };
    await journal.write(operation);
    const restored = await new DataRestoreSession(userData, backups, journal).run(operation, '0.8.0');
    const fence = new RestoredExecutionFence(userData, registry);
    await fence.retain(operation.generation!);
    await journal.write({ ...restored, phase: 'complete' });
    await fence.resumeFutureWork(operation.generation!);
    const restartedFence = new RestoredExecutionFence(userData, registry); await restartedFence.load();
    expect(restartedFence.automaticSchedulingAllowed()).toBe(true);
    expect(restartedFence.allows('task', fixture.taskId)).toBe(false);
    expect(restartedFence.allows('run', fixture.occurrenceId)).toBe(false);
    expect(restartedFence.allows('session', fixture.delegationId)).toBe(false);
    expect(restartedFence.allows('goal', `${fixture.threadId}:1`)).toBe(false);
    expect(await readFile(join(external, 'effect.txt'), 'utf8')).toBe('This external effect already happened.');

    const catalog = new ThreadMetadataStore(join(userData, 'agent/state.sqlite'), openLifecycleDatabase(join(userData, 'agent/state.sqlite'), false));
    expect(catalog.require(fixture.threadId).thread.name).toBe('Compatibility fixture conversation');
    expect(catalog.projects.membership(fixture.threadId).projectId).toBe(fixture.projectId); catalog.close();
    const history = new ThreadHistoryProjectionStore(join(userData, 'agent/thread_history.sqlite'), openLifecycleDatabase(join(userData, 'agent/thread_history.sqlite'), false));
    expect(history.listTurns({ threadId: fixture.threadId, cursor: null, limit: 10, itemsView: 'full' }).data[0]?.items.some((item) => item.type === 'agentMessage' && item.text === 'Recorded fixture answer')).toBe(true);
    history.close();
    expect(await readFile(join(userData, 'agent/user/USER.md'), 'utf8')).toContain('Prefer concrete explanations');
    const workspace = await new WorkspaceTransactionLog(join(userData, 'outline-runtime/workspace')).load();
    expect(workspace.snapshot?.shared).toMatchObject({ workspaceId: fixture.workspaceId, documentId: fixture.documentId });
    const resources = new AgentResourceStore(join(userData, 'agent/resource_references.sqlite'), join(userData, 'content'), join(userData, 'agent/scratch'),
      Date.now, openLifecycleDatabase(join(userData, 'agent/resource_references.sqlite'), false));
    expect((await resources.readExact(fixture.resource))?.toString()).toBe('Exact attachment fixture\n'); await resources.close();

    const taskDb = openLifecycleDatabase(join(userData, 'agent/goals.sqlite'), false);
    const restoredTasks = new ToolTaskStore(taskDb);
    const taskService = new ToolTaskService(restoredTasks, join(userData, 'agent/tool-tasks'), undefined, undefined, undefined, undefined, restartedFence);
    expect(restoredTasks.read(fixture.taskId)?.state).toBe('running');
    expect(restoredTasks.nonterminal()).toEqual([]);
    await expect(taskService.stop(fixture.taskId, fixture.threadId)).rejects.toThrow('no current process-control authority');
    await expect(assertTaskDataAdmission(join(userData, 'agent/tool-tasks', fixture.taskId, 'config.json'), fixture.taskId)).rejects.toThrow('cannot relaunch');
    taskDb.close();
    const scheduleDb = openLifecycleDatabase(join(userData, 'agent/scheduled-tasks.sqlite'), false);
    const schedules = new AutomationStore(join(userData, 'agent/scheduled-tasks.sqlite'), scheduleDb);
    schedules.setRestoredRunIds(restartedFence.blockedIdentities('run'));
    expect(schedules.readRun(fixture.occurrenceId)?.state).toBe('pending'); expect(schedules.pendingRuns()).toEqual([]);
    const dispatcher = new AutomationDispatcher({ store: schedules, canRecoverRun: (id) => restartedFence.allows('run', id) } as ConstructorParameters<typeof AutomationDispatcher>[0]);
    expect((await dispatcher.dispatch(schedules.readRun(fixture.occurrenceId)!)).id).toBe(fixture.occurrenceId);
    schedules.close();
    const memory = new MemoryControlStore(join(userData, 'agent/memories.sqlite'), openLifecycleDatabase(join(userData, 'agent/memories.sqlite'), false));
    memory.setRestoredJobIds(restartedFence.blockedIdentities('memory-job'));
    expect(memory.threadMode(fixture.threadId)).toBe('enabled'); expect(memory.nextJob(5000)).toBeNull();
    memory.enqueueJob('new-work', 'phase1', { threadId: fixture.threadId }, 2000);
    expect(memory.nextJob(5000)?.key).toBe('new-work'); memory.close();
  }, 30_000);
});
