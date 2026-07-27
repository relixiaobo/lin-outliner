import { describe, expect, test } from 'bun:test';
import {
  agentToolResult,
  errorEnvelope,
  isToolEnvelope,
  successEnvelope,
  toolEnvelopeAfterToolCall,
} from '../../src/main/agent/capabilities/agentToolEnvelope';

describe('agent tool envelope', () => {
  test('builds pi-agent-core compatible tool results with model-visible content', () => {
    const envelope = successEnvelope('example_tool', { secret: 'full', visible: 'yes' });
    const result = agentToolResult(envelope, { visible: 'yes' });

    expect(result.details).toBe(envelope);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const [content] = result.content;
    if (!content || content.type !== 'text') throw new Error('Expected text content');
    // The model-visible JSON drops the echoed `tool` and the redundant
    // `status: 'success'` (implied by `ok: true`); the full envelope stays on details.
    expect(JSON.parse(content.text)).toEqual({
      ok: true,
      data: { visible: 'yes' },
    });
  });

  test('model-visible envelope keeps only an informative status and a projected error', () => {
    const unchanged = agentToolResult(
      successEnvelope('example_tool', { full: 'data' }, { status: 'unchanged' }),
      { slim: 'view' },
    );
    expect(JSON.parse((unchanged.content[0] as { text: string }).text)).toEqual({
      ok: true,
      status: 'unchanged',
      data: { slim: 'view' },
    });

    const failed = agentToolResult(errorEnvelope('example_tool', 'bad_input', 'Bad input'));
    // No `tool`, no `status: 'error'` (implied by `ok: false`), and the visible
    // error is `{ code, message }` only — `recoverable` stays on details.
    expect(JSON.parse((failed.content[0] as { text: string }).text)).toEqual({
      ok: false,
      error: { code: 'bad_input', message: 'Bad input' },
    });
  });

  test('maps Lin error envelopes to pi-agent-core tool errors after execution', () => {
    const envelope = errorEnvelope('example_tool', 'bad_input', 'Bad input');

    expect(isToolEnvelope(envelope)).toBe(true);
    expect(toolEnvelopeAfterToolCall(envelope, false)).toEqual({ isError: true });
  });

  test('does not override successful or already-error tool results', () => {
    expect(toolEnvelopeAfterToolCall(successEnvelope('example_tool', {}), false)).toBeUndefined();
    expect(toolEnvelopeAfterToolCall(errorEnvelope('example_tool', 'bad_input', 'Bad input'), true)).toBeUndefined();
    expect(toolEnvelopeAfterToolCall({ ok: false }, false)).toBeUndefined();
  });
});
