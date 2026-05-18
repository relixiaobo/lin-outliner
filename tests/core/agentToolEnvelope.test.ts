import { describe, expect, test } from 'bun:test';
import {
  agentToolResult,
  errorEnvelope,
  isToolEnvelope,
  successEnvelope,
  toolEnvelopeAfterToolCall,
} from '../../src/main/agentToolEnvelope';

describe('agent tool envelope', () => {
  test('builds pi-agent-core compatible tool results with model-visible content', () => {
    const envelope = successEnvelope('example_tool', { secret: 'full', visible: 'yes' });
    const result = agentToolResult(envelope, { visible: 'yes' });

    expect(result.details).toBe(envelope);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const [content] = result.content;
    if (!content || content.type !== 'text') throw new Error('Expected text content');
    expect(JSON.parse(content.text)).toEqual({
      ok: true,
      tool: 'example_tool',
      status: 'success',
      data: { visible: 'yes' },
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
