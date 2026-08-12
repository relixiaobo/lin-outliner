import { describe, expect, test } from 'bun:test';
import { AppQuitCoordinator, type QuitCoordinatorHost, type QuitDecision, type QuitDrainOutcome } from '../../src/main/appQuitCoordinator';

class FakeQuitHost implements QuitCoordinatorHost {
  accepted = 1;
  durable = 0;
  frozen = false;
  teardownCount = 0;
  exitCount = 0;
  drains = 0;
  decisions: QuitDecision[] = [];
  injectRevisionOnDrain = false;

  freezeAdmission(): void { this.frozen = true; }
  unfreezeAdmission(): void { this.frozen = false; }
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
  exit(): void { this.exitCount += 1; }
}

describe('AppQuitCoordinator', () => {
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
    expect(host.exitCount).toBe(1);
  });
});
