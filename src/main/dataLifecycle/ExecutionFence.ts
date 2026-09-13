import { lstat } from 'node:fs/promises';
import { DATA_OPERATION_ID } from '../../core/dataLifecycle';
import { type RestoredWorkAdmission, type RestoredWorkKind } from '../agent/restoredWork';
import { assertOwnedPath, missing, readPrivateJson, record, writeDurableJson } from './durableFiles';
import { DataStoreRegistry } from './storeRegistry';
import { assertTaskProducersQuiescent } from '../agent/tasks/inspectTaskProducers';

interface RestoredWorkRecord {
  readonly version: 1;
  readonly generation: string;
  readonly entries: readonly { readonly kind: RestoredWorkKind; readonly id: string }[];
}

const WORK_QUERIES: readonly { store: string; kind: RestoredWorkKind; sql: string }[] = [
  { store: 'agent-goals', kind: 'task', sql: 'SELECT task_id AS id FROM tool_tasks' },
  { store: 'agent-goals', kind: 'goal', sql: "SELECT thread_id || ':' || generation AS id FROM goals" },
  { store: 'agent-schedules', kind: 'run', sql: 'SELECT id FROM automation_runs' },
  { store: 'agent-delegation', kind: 'session', sql: 'SELECT session_id AS id FROM delegation_sessions' },
  { store: 'profile-files', kind: 'profile', sql: 'SELECT id FROM profile_publications' },
  { store: 'agent-memory', kind: 'memory-job', sql: "SELECT key || ':' || updated_at AS id FROM dirty_jobs" },
  { store: 'agent-memory', kind: 'memory-publication', sql: "SELECT id FROM publications WHERE status = 'prepared'" },
  { store: 'agent-state', kind: 'thread', sql: 'SELECT id FROM threads' },
];
const WORK_KINDS = new Set(WORK_QUERIES.map((entry) => entry.kind));

export class RestoredExecutionFence implements RestoredWorkAdmission {
  generation: string | null = null;
  private paused = false;
  private readonly blocked = new Map<RestoredWorkKind, Set<string>>();
  private writeTail: Promise<void> = Promise.resolve();
  constructor(private readonly userData: string, private readonly registry: DataStoreRegistry) {}

  allows(kind: RestoredWorkKind, identity: string): boolean { return !this.blocked.get(kind)?.has(identity); }
  blockedIdentities(kind: RestoredWorkKind): readonly string[] { return [...(this.blocked.get(kind) ?? [])]; }
  automaticSchedulingAllowed(): boolean { return !this.paused; }

  authorizeGoal(identity: string): Promise<void> {
    const run = this.writeTail.then(async () => {
      if (!this.generation || this.allows('goal', identity)) return;
      const path = await assertOwnedPath(this.userData, `data-lifecycle/restored-work/${this.generation}.json`);
      const value = await readPrivateJson(path, 64 * 1024 * 1024);
      if (!record(value) || !Array.isArray(value.entries)) throw new Error('Restored goal authorization is unavailable');
      const entries = value.entries.filter((entry) => !record(entry) || entry.kind !== 'goal' || entry.id !== identity);
      await writeDurableJson(path, { ...value, entries });
      this.blocked.get('goal')?.delete(identity);
    });
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<void> {
    const control = await readPrivateJson(await assertOwnedPath(this.userData, 'data-lifecycle/execution-fence.json'));
    if (control === null) { this.blocked.clear(); this.generation = null; this.paused = false; return; }
    const nextBlocked = new Map<RestoredWorkKind, Set<string>>();
    if (!record(control) || control.version !== 1 || typeof control.generation !== 'string'
      || !DATA_OPERATION_ID.test(control.generation) || typeof control.paused !== 'boolean') throw new Error('Invalid restored execution fence');
    const retained = await readPrivateJson(await assertOwnedPath(this.userData, `data-lifecycle/restored-work/${control.generation}.json`), 64 * 1024 * 1024);
    if (!record(retained) || retained.version !== 1 || retained.generation !== control.generation
      || !Array.isArray(retained.entries) || retained.entries.length > 200_000) throw new Error('Restored work has not been classified');
    for (const entry of retained.entries) {
      if (!record(entry) || !WORK_KINDS.has(entry.kind as RestoredWorkKind) || typeof entry.id !== 'string' || entry.id.length > 2048) throw new Error('Invalid restored work identity');
      const kind = entry.kind as RestoredWorkKind;
      const values = nextBlocked.get(kind) ?? new Set<string>();
      values.add(entry.id); nextBlocked.set(kind, values);
    }
    this.blocked.clear(); for (const [kind, values] of nextBlocked) this.blocked.set(kind, values);
    this.generation = control.generation; this.paused = control.paused;
  }

  /** Called before any restored producer opens; only keys are retained, never new outcomes. */
  async retain(generation: string): Promise<void> {
    if (!DATA_OPERATION_ID.test(generation)) throw new Error('Invalid restore generation');
    const path = await assertOwnedPath(this.userData, `data-lifecycle/restored-work/${generation}.json`);
    if (await readPrivateJson(path, 64 * 1024 * 1024) !== null) { await this.load(); return; }
    const entries: { kind: RestoredWorkKind; id: string }[] = [];
    for (const query of WORK_QUERIES) {
      const store = this.registry.stores.find((entry) => entry.id === query.store)!;
      const databasePath = await assertOwnedPath(this.userData, store.path);
      const exists = await lstat(databasePath).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      if (!exists) continue;
      const database = this.registry.openDatabase(databasePath, true);
      try {
        const rows = database.prepare(`${query.sql} LIMIT 200001`).all() as { id: string }[];
        for (const row of rows) entries.push({ kind: query.kind, id: row.id });
        if (entries.length > 200_000) throw new Error('Restored work exceeds the bounded automatic-resumption inventory');
      } finally { database.close(); }
    }
    const retained: RestoredWorkRecord = { version: 1, generation, entries };
    await writeDurableJson(path, retained);
    await this.load();
  }

  async resumeFutureWork(generation: string): Promise<void> {
    await this.load();
    if (this.generation !== generation) throw new Error('Restore generation changed; inspect again');
    const path = await assertOwnedPath(this.userData, 'data-lifecycle/execution-fence.json');
    const control = await readPrivateJson(path);
    if (!record(control)) throw new Error('Restore fence is unavailable');
    await writeDurableJson(path, { ...control, paused: false });
    this.paused = false;
  }

  async assertNoLiveProducers(): Promise<void> {
    const store = this.registry.stores.find((entry) => entry.id === 'agent-goals');
    if (!store) return;
    const path = await assertOwnedPath(this.userData, store.path);
    if (!await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; })) {
      await assertTaskProducersQuiescent(this.userData, (id) => !this.allows('task', id));
      return;
    }
    let database;
    let candidates: ReadonlySet<string> | undefined;
    try {
      database = this.registry.openDatabase(path, true);
      const tasks = database.prepare("SELECT task_id, supervisor_pid, child_pid FROM tool_tasks WHERE state IN ('running', 'settling')").all() as {
        task_id: string; supervisor_pid: number | null; child_pid: number | null;
      }[];
      candidates = new Set(tasks.map((task) => task.task_id));
      if (tasks.some((task) => this.allows('task', task.task_id) && (processExists(task.supervisor_pid) || processExists(task.child_pid)))) {
        throw Object.assign(new Error('A Task process is still active. Stop its work before data maintenance.'), { code: 'SQLITE_BUSY' });
      }
    } catch (error) {
      if (record(error) && error.code === 'SQLITE_BUSY') throw error;
      // A damaged ledger is recoverable when independent process evidence proves
      // quiescence; it must not make a verified backup impossible to restore.
      candidates = undefined;
    } finally { database?.close(); }
    await assertTaskProducersQuiescent(this.userData, (id) => !this.allows('task', id), candidates);
  }
}

function processExists(pid: number | null): boolean {
  if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return record(error) && error.code === 'EPERM'; }
}
