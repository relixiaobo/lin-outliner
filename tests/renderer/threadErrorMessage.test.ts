import { describe, expect, test } from 'bun:test';
import { threadErrorMessage, userFacingAgentError } from '../../src/renderer/agent/threadErrorMessage';

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

  test('translates budget failures without exposing token counts', () => {
    const translated = '任务达到系统资源上限，成果已保全。';
    for (const raw of [
      'Token budget exhausted mid-Turn (1234 of 1000 tokens)',
      'Subagent token budget exhausted (1500001 of 1500000 tokens); the child refuses new work. '
        + 'Interrupt, review its output, or spawn a fresh child.',
    ]) {
      const rendered = userFacingAgentError(raw, translated);
      expect(rendered).toBe(translated);
      expect(rendered).not.toMatch(/\d/u);
    }
  });
});
