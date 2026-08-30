import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppQuitCoordinator, type QuitCoordinatorHost, type QuitDecision, type QuitDrainOutcome } from '../../src/main/appQuitCoordinator';

const MAIN_SOURCE = readFileSync(join(import.meta.dir, '../../src/main/main.ts'), 'utf8');
const DESKTOP_HOST_SOURCE = readFileSync(join(import.meta.dir, '../../src/main/desktopHost.ts'), 'utf8');

class FakeQuitHost implements QuitCoordinatorHost {
  accepted = 1;
  durable = 0;
  frozen = false;
  teardownCount = 0;
  shutdownCount = 0;
  commitFreezeCount = 0;
  exitCount = 0;
  drains = 0;
  decisions: QuitDecision[] = [];
  injectRevisionOnDrain = false;

  freezeAdmission(): void { this.frozen = true; }
  unfreezeAdmission(): void { this.frozen = false; }
  commitAdmissionFreeze(): void { this.commitFreezeCount += 1; }
  latestAcceptedRevision(): number { return this.accepted; }
  durableRevision(): number { return this.durable; }
  async drainToRevision(revision: number): Promise<void> {
    this.drains += 1;
    if (this.injectRevisionOnDrain) {
      this.injectRevisionOnDrain = false;
      this.accepted = revision + 1;
      this.durable = revision;
      return;
    }
    this.durable = revision;
  }
  async showDrainFailure(_error: unknown, _outcome: QuitDrainOutcome): Promise<QuitDecision> {
    return this.decisions.shift() ?? 'cancel';
  }
  async teardown(): Promise<void> { this.teardownCount += 1; }
  async shutdownRuntime(_signal: AbortSignal): Promise<void> { this.shutdownCount += 1; }
  exit(): void { this.exitCount += 1; }
}

describe('AppQuitCoordinator', () => {
  test('main constructs Desktop Host before readiness and Desktop Host installs quit coordination before startup', () => {
    const hostConstruction = MAIN_SOURCE.indexOf('const desktopHost = createDesktopHost({');
    const asynchronousStartup = MAIN_SOURCE.indexOf('app.whenReady()');
    const coordinatorSetup = DESKTOP_HOST_SOURCE.indexOf('quitCoordinator = new AppQuitCoordinator({');
    const lifecycleSetup = DESKTOP_HOST_SOURCE.indexOf('const lifecycle = new DesktopHostLifecycle({');

    expect(hostConstruction).toBeGreaterThan(-1);
    expect(asynchronousStartup).toBeGreaterThan(hostConstruction);
    expect(coordinatorSetup).toBeGreaterThan(-1);
    expect(lifecycleSetup).toBeGreaterThan(coordinatorSetup);
    expect(DESKTOP_HOST_SOURCE).not.toContain('if (!quitCoordinator) return;');
  });

  test('cancels a failed drain without tearing down live services', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error('disk offline');
    };
    host.decisions = ['cancel'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
    expect(host.teardownCount).toBe(0);
    expect(host.exitCount).toBe(0);
    expect(host.commitFreezeCount).toBe(0);
    expect(host.shutdownCount).toBe(0);
  });

  test('does not report cancellation until admission is confirmed unfrozen', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error('disk offline');
    };
    host.decisions = ['cancel'];
    let unfreezeAttempts = 0;
    host.unfreezeAdmission = async () => {
      unfreezeAttempts += 1;
      if (unfreezeAttempts === 1) throw new Error('Runtime unfreeze failed');
      host.frozen = false;
    };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await expect(coordinator.requestQuit()).rejects.toThrow('Runtime unfreeze failed');

    expect(coordinator.phase()).toBe('draining');
    expect(host.frozen).toBe(true);
    expect(host.teardownCount).toBe(0);
    expect(host.exitCount).toBe(0);

    host.decisions = ['cancel'];
    await coordinator.requestQuit();
    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
    expect(unfreezeAttempts).toBe(2);
  });

  test('retries and then enters teardown only after the durable barrier', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async (revision) => {
      host.drains += 1;
      if (host.drains === 1) throw new Error('temporary failure');
      host.durable = revision;
    };
    host.decisions = ['retry'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(host.drains).toBe(2);
    expect(coordinator.phase()).toBe('done');
    expect(host.teardownCount).toBe(1);
    expect(host.exitCount).toBe(1);
    expect(host.commitFreezeCount).toBe(1);
    expect(host.shutdownCount).toBe(1);
  });

  test('honors repeated retry decisions until the user cancels', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error('disk offline');
    };
    host.decisions = [
      'retry', 'retry', 'retry', 'retry', 'retry',
      'retry', 'retry', 'retry', 'retry', 'retry',
      'cancel',
    ];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(host.drains).toBe(11);
    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
    expect(host.teardownCount).toBe(0);
    expect(host.exitCount).toBe(0);
  });

  test('rechecks the barrier when a revision is accepted during drain', async () => {
    const host = new FakeQuitHost();
    host.injectRevisionOnDrain = true;
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(host.drains).toBe(2);
    expect(host.durable).toBe(host.accepted);
    expect(host.exitCount).toBe(1);
  });

  test('quit anyway tears down after a timeout while leaving admission frozen', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = () => new Promise<void>(() => undefined);
    host.decisions = ['quit-anyway'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 5 });

    await coordinator.requestQuit();

    expect(coordinator.phase()).toBe('done');
    expect(host.frozen).toBe(true);
    expect(host.teardownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });

  test('reuses a timed-out drain on retry instead of overlapping it', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = () => {
      host.drains += 1;
      return new Promise<void>(() => undefined);
    };
    host.decisions = ['retry', 'quit-anyway'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 5 });

    await coordinator.requestQuit();

    expect(host.drains).toBe(1);
    expect(host.teardownCount).toBe(1);
  });

  test('turns a synchronous drain throw into the normal failure dialog path', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = () => { throw new Error('sync drain failure'); };
    host.decisions = ['cancel'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
  });

  test('shares concurrent quit requests and tears down exactly once', async () => {
    const host = new FakeQuitHost();
    let releaseDrain!: () => void;
    host.drainToRevision = (revision) => new Promise<void>((resolve) => {
      releaseDrain = () => {
        host.durable = revision;
        resolve();
      };
    });
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 100 });

    const first = coordinator.requestQuit();
    const second = coordinator.requestQuit();
    expect(first).toBe(second);
    await Promise.resolve();
    releaseDrain();
    await first;

    expect(host.teardownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });

  test('a dialog error cancels the reversible phase and leaves admission open', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error('disk offline');
    };
    host.showDrainFailure = async () => { throw new Error('dialog unavailable'); };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await expect(coordinator.requestQuit()).rejects.toThrow('dialog unavailable');
    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
    expect(host.teardownCount).toBe(0);
    expect(host.exitCount).toBe(0);
  });

  test('routes an asynchronous barrier status failure through the reversible decision path', async () => {
    const host = new FakeQuitHost();
    host.durableRevision = async () => {
      throw new Error('Runtime status unavailable');
    };
    host.decisions = ['cancel'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(coordinator.phase()).toBe('idle');
    expect(host.frozen).toBe(false);
    expect(host.teardownCount).toBe(0);
    expect(host.exitCount).toBe(0);
  });

  test('cancel permits a later quit request to drain again', async () => {
    const host = new FakeQuitHost();
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error('disk offline');
    };
    host.decisions = ['cancel', 'quit-anyway'];
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();
    await coordinator.requestQuit();
    expect(host.drains).toBe(2);
    expect(host.teardownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });

  test('retry reports the current drain failure instead of reusing an older error', async () => {
    const host = new FakeQuitHost();
    const shown: string[] = [];
    host.drainToRevision = async () => {
      host.drains += 1;
      throw new Error(host.drains === 1 ? 'first failure' : 'second failure');
    };
    host.decisions = ['retry', 'cancel'];
    host.showDrainFailure = async (error) => {
      shown.push(error instanceof Error ? error.message : String(error));
      return host.decisions.shift() ?? 'cancel';
    };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(shown).toEqual(['first failure', 'second failure']);
    expect(host.frozen).toBe(false);
  });

  test('phase-two teardown remains irreversible when teardown rejects', async () => {
    const host = new FakeQuitHost();
    host.durable = host.accepted;
    host.teardown = async () => {
      host.teardownCount += 1;
      throw new Error('teardown failed');
    };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await expect(coordinator.requestQuit()).rejects.toThrow('teardown failed');

    expect(coordinator.phase()).toBe('done');
    expect(host.frozen).toBe(true);
    expect(host.shutdownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });

  test('phase two still tears down and exits when the Runtime freeze commit rejects', async () => {
    const host = new FakeQuitHost();
    host.durable = host.accepted;
    host.commitAdmissionFreeze = async () => {
      host.commitFreezeCount += 1;
      throw new Error('Runtime freeze acknowledgement failed');
    };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await expect(coordinator.requestQuit()).rejects.toThrow('Runtime freeze acknowledgement failed');

    expect(coordinator.phase()).toBe('done');
    expect(host.frozen).toBe(true);
    expect(host.commitFreezeCount).toBe(1);
    expect(host.teardownCount).toBe(1);
    expect(host.shutdownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });

  test('phase two commits, tears down consumers, stops Runtime, and then exits', async () => {
    const host = new FakeQuitHost();
    const order: string[] = [];
    host.durable = host.accepted;
    host.commitAdmissionFreeze = () => {
      host.commitFreezeCount += 1;
      order.push('commit-freeze');
    };
    host.teardown = async () => {
      host.teardownCount += 1;
      order.push('teardown');
    };
    host.shutdownRuntime = async () => {
      host.shutdownCount += 1;
      order.push('shutdown-runtime');
    };
    host.exit = () => {
      host.exitCount += 1;
      order.push('exit');
    };
    const coordinator = new AppQuitCoordinator(host, { drainTimeoutMs: 50 });

    await coordinator.requestQuit();

    expect(order).toEqual(['commit-freeze', 'teardown', 'shutdown-runtime', 'exit']);
  });

  test('bounds Runtime shutdown and exits after the irreversible phase starts', async () => {
    const host = new FakeQuitHost();
    host.durable = host.accepted;
    host.shutdownRuntime = (signal) => {
      host.shutdownCount += 1;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const coordinator = new AppQuitCoordinator(host, {
      drainTimeoutMs: 50,
      runtimeShutdownTimeoutMs: 5,
    });

    await expect(coordinator.requestQuit()).rejects.toThrow('Outline Runtime shutdown timed out.');

    expect(coordinator.phase()).toBe('done');
    expect(host.shutdownCount).toBe(1);
    expect(host.exitCount).toBe(1);
  });
});
