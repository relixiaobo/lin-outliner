import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OutlineClientSupervisor, type OutlineRuntimeLaunch } from '../../outline/client';
import { decodeOutlineDataInspection, type OutlineDataInspection } from '../../outline/contract/dataInspection';
import { OutlineRuntimeLock, resolveOutlineRuntimePaths } from '../../outline/runtimeLock';
import { assertOwnedPath, syncDirectory, writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export interface WriterBarrierOptions {
  readonly launch: OutlineRuntimeLaunch;
  readonly assertNoLiveProducers: () => Promise<void>;
  readonly checkpoint?: DataLifecycleCheckpoint;
}

export class DataWriterBarrier {
  private lock: OutlineRuntimeLock | null = null;
  private readonly paths;
  private readonly supervisor: OutlineClientSupervisor;
  constructor(private readonly userData: string, private readonly options: WriterBarrierOptions) {
    this.paths = resolveOutlineRuntimePaths(join(userData, 'outline-runtime'));
    this.supervisor = new OutlineClientSupervisor({ root: this.paths.root, contentRoot: join(userData, 'content'), noStart: true });
  }

  async acquire(): Promise<void> {
    if (this.lock) throw new Error('Data maintenance already owns the writer barrier');
    await this.options.assertNoLiveProducers();
    await this.supervisor.quiesceForMaintenance();
    await this.acquireRuntimeLock();
    try {
      // A producer discovered after the first observation invalidates acquisition.
      await this.options.assertNoLiveProducers();
      await this.options.checkpoint?.('writer-barrier-acquired');
    } catch (error) { await this.release(); throw error; }
  }

  async inspectOutline(userData = this.userData): Promise<OutlineDataInspection> {
    const launch = this.options.launch;
    const args = [...launch.args];
    for (const [flag, value] of [['--root', join(userData, 'outline-runtime')], ['--content-root', join(userData, 'content')]]) {
      const index = args.indexOf(flag!);
      if (index < 0 || index + 1 >= args.length) throw new Error('Runtime inspection requires explicit owned roots');
      args[index + 1] = value!;
    }
    const text = await new Promise<string>((resolve, reject) => {
      execFile(launch.command, [...args, '--inspect-data'], {
        env: { ...process.env, ...launch.env, ELECTRON_RUN_AS_NODE: '1', TENON_OUTLINE_STARTUP_REPORT_FD: '', TENON_OUTLINE_STARTUP_REPORT_PATH: '' },
        timeout: 30_000, maxBuffer: 32 * 1024, encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return decodeOutlineDataInspection(JSON.parse(text));
  }

  async initializeOutline(operationId: string): Promise<void> {
    if (!this.lock) throw new Error('Outline initialization requires the maintenance barrier');
    const token = randomUUID();
    const permitPath = await assertOwnedPath(this.userData, 'data-lifecycle/runtime-permit.json');
    await writeDurableJson(permitPath, { version: 1, operationId, pid: process.pid, token }, this.options.checkpoint);
    await this.release();
    const bootstrap = new OutlineClientSupervisor({ root: this.paths.root, contentRoot: join(this.userData, 'content'),
      launch: { ...this.options.launch, env: { ...this.options.launch.env, TENON_DATA_LIFECYCLE_TOKEN: token } },
      origin: 'desktop' });
    try {
      const client = await bootstrap.connect();
      client.close();
      await bootstrap.shutdown();
      await this.acquireRuntimeLock();
    } catch (error) {
      await bootstrap.shutdown().catch(() => undefined);
      throw error;
    } finally {
      await rm(permitPath, { force: true });
      await syncDirectory(join(this.userData, 'data-lifecycle'));
    }
  }

  async release(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release();
  }

  private async acquireRuntimeLock(): Promise<void> {
    await assertOwnedPath(this.userData, 'outline-runtime');
    const owner = { pid: process.pid, instanceId: `maintenance:${randomUUID()}`, createdAt: new Date().toISOString() };
    this.lock = await OutlineRuntimeLock.acquire(this.paths, owner);
    if (!this.lock) throw Object.assign(new Error('Another process owns Outline storage. Stop its work and retry data maintenance.'), { code: 'SQLITE_BUSY' });
  }
}
