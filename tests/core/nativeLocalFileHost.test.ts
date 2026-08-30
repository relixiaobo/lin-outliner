import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createLocalFileProcessTracker } from '../../src/main/hostPlatform/localFileProcessTracker';

describe('LocalFileProcessTracker', () => {
  test('close kills, detaches, and awaits in-flight processes once', async () => {
    const children: FakeSearchProcess[] = [];
    const commands: string[] = [];
    const tracker = createLocalFileProcessTracker((command) => {
      commands.push(command);
      const child = new FakeSearchProcess();
      children.push(child);
      return child as never;
    });

    tracker.spawn('/usr/bin/mdfind', ['-0', '-name', 'report'], {});
    tracker.spawn('/usr/bin/rg', ['--files'], {});
    expect(commands).toEqual(['/usr/bin/mdfind', '/usr/bin/rg']);

    const firstClose = tracker.close();
    expect(tracker.close()).toBe(firstClose);
    expect(children.every((child) => child.killed && child.detached)).toBe(true);

    let closed = false;
    void firstClose.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    children[0]!.settle();
    await Promise.resolve();
    expect(closed).toBe(false);
    children[1]!.settle();
    await firstClose;
    expect(closed).toBe(true);

    expect(tracker.spawn('/usr/bin/mdfind', [], {})).toBeNull();
    expect(commands).toHaveLength(2);
  });

  test('an error settles close even when no close event follows', async () => {
    const child = new FakeSearchProcess();
    const tracker = createLocalFileProcessTracker(() => child as never);
    tracker.spawn('/usr/bin/mdfind', [], {});

    const close = tracker.close();
    child.fail();

    await close;
    expect(child.killed).toBe(true);
    expect(child.detached).toBe(true);
  });
});

class FakeSearchProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  detached = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {
    this.detached = true;
  }

  settle(): void {
    this.exitCode = 0;
    this.emit('close', 0, null);
  }

  fail(): void {
    this.emit('error', new Error('spawn failed'));
  }
}
