import { describe, expect, test } from 'bun:test';
import { awaitWithAbort, AwaitTimeoutError } from '../../src/main/agent/capabilities/agentAwaitWithAbort';

describe('awaitWithAbort', () => {
  test('returns the original promise result', async () => {
    await expect(awaitWithAbort(Promise.resolve('ok'))).resolves.toBe('ok');
  });

  test('rejects when the signal aborts before the promise settles', async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => undefined);
    const wrapped = awaitWithAbort(pending, { signal: controller.signal });

    controller.abort(new DOMException('Stopped', 'AbortError'));

    await expect(wrapped).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects when the timeout wins', async () => {
    const pending = new Promise<string>(() => undefined);

    await expect(awaitWithAbort(pending, { timeoutMs: 1 })).rejects.toBeInstanceOf(AwaitTimeoutError);
  });
});
