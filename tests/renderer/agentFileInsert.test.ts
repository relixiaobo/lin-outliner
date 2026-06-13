import { afterEach, describe, expect, test } from 'bun:test';
import {
  onInsertFileIntoOutlinerRequest,
  requestInsertFileIntoOutliner,
} from '../../src/renderer/agent/agentFileInsert';

// The channel is module-global; always unregister so one test cannot leak its
// handler into the next.
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('agent file insert channel', () => {
  test('routes the request to the registered bridge and returns whether it inserted', async () => {
    const seen: string[] = [];
    cleanup = onInsertFileIntoOutlinerRequest(async (path) => {
      seen.push(path);
      return true;
    });
    expect(await requestInsertFileIntoOutliner('/workdir/report.md')).toBe(true);
    expect(seen).toEqual(['/workdir/report.md']);
  });

  test('returns false when the bridge inserted nothing (file gone / out of root)', async () => {
    cleanup = onInsertFileIntoOutlinerRequest(async () => false);
    expect(await requestInsertFileIntoOutliner('/workdir/gone.md')).toBe(false);
  });

  test('propagates a bridge failure so the chip can stay un-confirmed', async () => {
    cleanup = onInsertFileIntoOutlinerRequest(async () => {
      throw new Error('ingest failed');
    });
    await expect(requestInsertFileIntoOutliner('/workdir/report.md')).rejects.toThrow('ingest failed');
  });

  test('resolves to false with no bridge registered', async () => {
    expect(await requestInsertFileIntoOutliner('/workdir/report.md')).toBe(false);
  });

  test('unsubscribe detaches the bridge', async () => {
    let calls = 0;
    const unsubscribe = onInsertFileIntoOutlinerRequest(async () => {
      calls += 1;
      return true;
    });
    unsubscribe();
    await requestInsertFileIntoOutliner('/workdir/report.md');
    expect(calls).toBe(0);
  });

  test('the last registration wins', async () => {
    const calls: string[] = [];
    const off1 = onInsertFileIntoOutlinerRequest(async () => {
      calls.push('first');
      return true;
    });
    cleanup = onInsertFileIntoOutlinerRequest(async () => {
      calls.push('second');
      return true;
    });
    await requestInsertFileIntoOutliner('/workdir/report.md');
    expect(calls).toEqual(['second']);
    off1();
  });
});
