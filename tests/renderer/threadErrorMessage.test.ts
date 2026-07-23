import { describe, expect, test } from 'bun:test';
import { threadErrorMessage } from '../../src/renderer/agent/threadErrorMessage';

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
