import { describe, expect, test } from 'bun:test';
import { isRerunnableTurn, threadErrorMessage } from '../../src/renderer/agent/threadErrorMessage';

describe('threadErrorMessage', () => {
  test('extracts a readable message from a provider JSON error', () => {
    expect(threadErrorMessage(
      'OpenRouter API error (404): {"error":{"message":"No endpoints found for gpt-5.4"},"request_id":"secret"}',
    )).toBe('HTTP 404 - No endpoints found for gpt-5.4');
  });

  test('extracts direct JSON and HTML error summaries', () => {
    expect(threadErrorMessage('{"error":{"message":"Rate limit reached"}}')).toBe('Rate limit reached');
    expect(threadErrorMessage('503 <!doctype html><title>Service unavailable</title>'))
      .toBe('HTTP 503 - Service unavailable');
  });

  test('bounds unstructured errors', () => {
    expect(threadErrorMessage(`Error: ${'x'.repeat(400)}`)).toBe(`${'x'.repeat(280)}...`);
  });

});

describe('rerunnable Turns', () => {
  const failed = (error: { message: string; code?: string } | null) => (
    { status: 'failed' as const, error } as Parameters<typeof isRerunnableTurn>[0]
  );

  test('offers a way out only where the same request could end differently', () => {
    // Circumstance: worth running again — including with nothing recorded to
    // argue it away.
    expect(isRerunnableTurn(failed({ message: 'boom', code: 'runtime_failure' }))).toBe(true);
    expect(isRerunnableTurn(failed(null))).toBe(true);
  });

  test('separates a host that died from a user who pressed Stop', () => {
    // Both are recorded as interrupts, and only one of them was a decision.
    expect(isRerunnableTurn({
      status: 'interrupted',
      error: { message: 'Turn interrupted by host restart', code: 'host_restart' },
    })).toBe(true);
    expect(isRerunnableTurn({ status: 'interrupted', error: null })).toBe(false);
    // Nothing to run again while it is still running.
    expect(isRerunnableTurn({ status: 'inProgress', error: null })).toBe(false);
    expect(isRerunnableTurn({ status: 'completed', error: null })).toBe(false);
  });
});
