import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedPopulatedDataFixture, type PopulatedDataFixture } from '../tests/fixtures/dataLifecycle';
import { DataLifecycleCoordinator } from '../src/main/dataLifecycle/DataLifecycleCoordinator';
import { DataStoreRegistry } from '../src/main/dataLifecycle/storeRegistry';
import { DataWriterBarrier } from '../src/main/dataLifecycle/WriterBarrier';
import { RestoredExecutionFence } from '../src/main/dataLifecycle/ExecutionFence';
import { openLifecycleDatabase } from '../src/main/dataLifecycle/sqlite';
import { ThreadMetadataStore } from '../src/main/agent/persistence/ThreadMetadataStore';
import { ThreadHistoryProjectionStore } from '../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { AgentResourceStore } from '../src/main/agent/persistence/AgentResourceStore';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageInfo = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
const lock = await readFile(join(repo, 'bun.lock'), 'utf8');
const lockedLoro = lock.match(/"loro-crdt":\s*\["loro-crdt@([^"]+)"/)?.[1];
const installedLoro = JSON.parse(await readFile(join(repo, 'node_modules/loro-crdt/package.json'), 'utf8')).version;
assert.equal(installedLoro, lockedLoro, 'Run the checker with the exact lockfile-resolved Loro package');
const output = join(repo, 'tmp/data-lifecycle-checks', randomUUID());
await mkdir(output, { recursive: true });
const suppliedIndex = process.argv.indexOf('--fixture');
let source: string;
let metadata: { kind: 'tenon-data-fixture'; version: 1; applicationVersion: string; sourceRevision: string; sourceDirty: boolean; loroVersion: string; expected: PopulatedDataFixture };
if (suppliedIndex >= 0) {
  assert(process.argv[suppliedIndex + 1], '--fixture requires a fixture directory');
  source = resolve(process.argv[suppliedIndex + 1]!);
  metadata = JSON.parse(await readFile(join(source, 'fixture.json'), 'utf8'));
  assert.equal(metadata.kind, 'tenon-data-fixture'); assert.equal(metadata.version, 1);
} else {
  source = join(output, 'source');
  const expected = await seedPopulatedDataFixture(source, { versioned: false });
  metadata = { kind: 'tenon-data-fixture', version: 1, applicationVersion: packageInfo.version,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    loroVersion: installedLoro, expected };
  await writeFile(join(source, 'fixture.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}
const working = join(output, 'working');
await cp(source, working, { recursive: true, dereference: false, errorOnExist: true, force: false });

function create() {
  const registry = new DataStoreRegistry();
  const fence = new RestoredExecutionFence(working, registry);
  const barrier = new DataWriterBarrier(working, {
    launch: { command: process.execPath, args: [join(repo, 'src/outline/runtime/server/entry.ts'), '--root', join(working, 'outline-runtime'), '--content-root', join(working, 'content')] },
    assertNoLiveProducers: () => fence.assertNoLiveProducers(),
  });
  return new DataLifecycleCoordinator({ userData: working, applicationVersion: packageInfo.version, registry, barrier,
    prepareRestoredExecution: (generation) => fence.retain(generation), resumeAutomaticExecution: (generation) => fence.resumeFutureWork(generation) });
}

let coordinator = create();
try {
  await coordinator.prepare();
  assert.equal(coordinator.state().phase, 'ready', JSON.stringify(coordinator.state().issues));
  await coordinator.request({ action: 'backup' }); await coordinator.close();
  coordinator = create(); await coordinator.prepare();
  const state = await coordinator.inspectBackups();
  const backup = state.backups.find((entry) => entry.purpose === 'backup' && entry.verified && entry.fileCount > 0);
  assert(backup, 'A completed populated backup is required');
  await coordinator.request({ action: 'restore', backupId: backup.id, revision: state.revision });
  await coordinator.close(); coordinator = create(); await coordinator.prepare();
  assert.equal(coordinator.state().phase, 'ready', JSON.stringify(coordinator.state().issues));
  assert.equal(coordinator.state().automaticExecutionPaused, true);
  const expected = metadata.expected;
  const catalog = new ThreadMetadataStore(join(working, 'agent/state.sqlite'), openLifecycleDatabase(join(working, 'agent/state.sqlite'), false));
  assert.equal(catalog.require(expected.threadId).thread.name, 'Compatibility fixture conversation');
  assert.equal(catalog.projects.membership(expected.threadId).projectId, expected.projectId); catalog.close();
  const history = new ThreadHistoryProjectionStore(join(working, 'agent/thread_history.sqlite'), openLifecycleDatabase(join(working, 'agent/thread_history.sqlite'), false));
  assert(history.listTurns({ threadId: expected.threadId, cursor: null, limit: 10, itemsView: 'full' }).data.some((turn) => turn.id === expected.turnId)); history.close();
  assert((await readFile(join(working, 'agent/user/USER.md'), 'utf8')).includes('Prefer concrete explanations'));
  const resources = new AgentResourceStore(join(working, 'agent/resource_references.sqlite'), join(working, 'content'), join(working, 'agent/scratch'), Date.now,
    openLifecycleDatabase(join(working, 'agent/resource_references.sqlite'), false));
  assert.equal((await resources.readExact(expected.resource))?.toString(), 'Exact attachment fixture\n'); await resources.close();
  for (const [path, sql, id] of [
    ['agent/goals.sqlite', 'SELECT task_id FROM tool_tasks WHERE task_id = ?', expected.taskId],
    ['agent/scheduled-tasks.sqlite', 'SELECT id FROM automation_runs WHERE id = ?', expected.occurrenceId],
    ['agent/delegation.sqlite', 'SELECT session_id FROM delegation_sessions WHERE session_id = ?', expected.delegationId],
    ['agent/memories.sqlite', 'SELECT key FROM dirty_jobs WHERE key = ?', `phase1:${expected.threadId}`],
  ]) {
    const database = openLifecycleDatabase(join(working, path!), true);
    try { assert(database.prepare(sql!).get(id!), `${path} did not retain its fixture record`); } finally { database.close(); }
  }
  const manifest = JSON.parse(await readFile(join(working, 'data-manifest.json'), 'utf8'));
  assert.equal(manifest.identityReferences.workspaceId, expected.workspaceId);
  assert.equal(manifest.identityReferences.documentId, expected.documentId);
  const report = { passed: true, scope: suppliedIndex >= 0 ? 'provided fixture upgrade and restore' : 'development fixture bootstrap and restore',
    source: metadata, target: { applicationVersion: packageInfo.version, declaredLoro: packageInfo.dependencies['loro-crdt'], lockedLoro },
    output, assertions: ['physical compatibility', 'populated backup', 'restore', 'identity', 'conversations', 'projects', 'profile', 'memory', 'tasks', 'schedules', 'delegation', 'attachment bytes', 'execution fence'] };
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, scope: report.scope, report: join(output, 'report.json'), fixture: source }));
} finally { await coordinator.close(); }
