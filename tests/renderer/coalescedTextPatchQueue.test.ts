import { describe, expect, test } from 'bun:test';
import { plainText, type RichTextPatch } from '../../src/renderer/api/types';
import { CoalescedTextPatchQueue } from '../../src/renderer/ui/editor/coalescedTextPatchQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('CoalescedTextPatchQueue', () => {
  test('keeps one write in flight and replaces queued edits with the latest content', async () => {
    const queue = new CoalescedTextPatchQueue();
    const first = deferred<void>();
    const sent: RichTextPatch[] = [];
    const send = (patch: RichTextPatch) => {
      sent.push(patch);
      return sent.length === 1 ? first.promise : Promise.resolve();
    };
    const insertA: RichTextPatch = { ops: [{ type: 'insert_text', at: 0, text: 'a' }] };

    queue.enqueue({ key: 'node:a', patch: insertA, latestContent: plainText('a'), send });
    queue.enqueue({ key: 'node:a', patch: insertA, latestContent: plainText('ab'), send });
    const idle = queue.enqueue({ key: 'node:a', patch: insertA, latestContent: plainText('abc'), send });

    expect(sent).toEqual([insertA]);
    expect(queue.isBusy()).toBe(true);
    first.resolve();
    await idle;

    expect(sent).toEqual([
      insertA,
      { ops: [{ type: 'replace_all', content: plainText('abc') }] },
    ]);
    expect(queue.isBusy()).toBe(false);
  });

  test('does not coalesce edits across different targets', async () => {
    const queue = new CoalescedTextPatchQueue();
    const first = deferred<void>();
    const sent: Array<{ key: string; patch: RichTextPatch }> = [];
    const enqueue = (key: string, value: string, wait = false) => queue.enqueue({
      key,
      patch: { ops: [{ type: 'insert_text', at: 0, text: value }] },
      latestContent: plainText(value),
      send: async (patch) => {
        sent.push({ key, patch });
        if (wait) await first.promise;
      },
    });

    enqueue('node:a', 'a', true);
    enqueue('node:b', 'b');
    const idle = enqueue('node:b', 'bc');
    first.resolve();
    await idle;

    expect(sent.map(({ key }) => key)).toEqual(['node:a', 'node:b']);
    expect(sent[1]?.patch).toEqual({ ops: [{ type: 'replace_all', content: plainText('bc') }] });
  });

  test('continues to the latest state after a sender failure and accepts later work', async () => {
    const queue = new CoalescedTextPatchQueue();
    const first = deferred<void>();
    const sent: string[] = [];
    const send = async (patch: RichTextPatch) => {
      const op = patch.ops[0];
      sent.push(op?.type === 'replace_all' ? op.content.text : 'delta');
      if (sent.length === 1) await first.promise;
    };

    const failed = queue.enqueue({
      key: 'node:a',
      patch: { ops: [{ type: 'insert_text', at: 0, text: 'a' }] },
      latestContent: plainText('a'),
      send: async () => {
        await first.promise;
        sent.push('failed');
        throw new Error('failed');
      },
    });
    queue.enqueue({
      key: 'node:a',
      patch: { ops: [{ type: 'insert_text', at: 1, text: 'b' }] },
      latestContent: plainText('ab'),
      send,
    });
    first.resolve();
    await expect(failed).rejects.toThrow('failed');
    expect(sent).toEqual(['failed', 'ab']);
    expect(queue.isBusy()).toBe(false);

    await queue.enqueue({
      key: 'node:a',
      patch: { ops: [{ type: 'insert_text', at: 2, text: 'c' }] },
      latestContent: plainText('abc'),
      send,
    });
    expect(sent.at(-1)).toBe('delta');
  });
});
