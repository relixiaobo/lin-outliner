import { describe, expect, test } from 'bun:test';
import { threadErrorMessage, userFacingAgentError,
  isRerunnableTurn,
} from '../../src/renderer/agent/threadErrorMessage';

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
    for (const error of [
      { message: 'Token budget exhausted mid-Turn (1234 of 1000 tokens)', code: 'subagent_budget_exhausted' },
      {
        message: 'Subagent token budget exhausted (1500001 of 1500000 tokens); the child refuses new work. '
          + 'Interrupt, review its output, or spawn a fresh child.',
        code: 'subagent_budget_exhausted',
      },
    ]) {
      const rendered = userFacingAgentError(error, translated);
      expect(rendered).toBe(translated);
      expect(rendered).not.toMatch(/\d/u);
    }
    expect(userFacingAgentError('Token budget exhausted mid-Turn (12 of 10 tokens)', translated))
      .toBe('Token budget exhausted mid-Turn (12 of 10 tokens)');
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
    // Spend is request-scoped: a new user Turn delegates against a fresh grant,
    // so restating the need is the recovery path the budget design names.
    expect(isRerunnableTurn(failed({ message: 'spent', code: 'subagent_budget_exhausted' }))).toBe(true);
    // Topology is Thread-lifetime: the next attempt meets the same wall.
    expect(isRerunnableTurn(failed({ message: 'too deep', code: 'subagent_structural_limit' }))).toBe(false);
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
