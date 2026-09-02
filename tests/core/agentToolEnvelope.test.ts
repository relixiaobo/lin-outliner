import { describe, expect, test } from 'bun:test';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
} from '../../src/main/agent/capabilities/agentToolEnvelope';
import { MODEL_TOOL_CATALOG } from '../../src/core/agent/tools';

describe('agent tool envelope', () => {
  test('builds semantic results without compiling model-visible content', () => {
    const envelope = successEnvelope('example_tool', { secret: 'full', visible: 'yes' });
    const result = agentToolResult(envelope, { visible: 'yes' });

    expect(result.details).toBe(envelope);
    expect(result).toMatchObject({
      kind: 'tenon',
      outcome: { ok: true },
      data: { visible: 'yes' },
      content: [],
    });
  });

  test('model-visible envelope keeps only an informative status and a projected error', () => {
    const unchanged = agentToolResult(
      successEnvelope('example_tool', { full: 'data' }, { status: 'unchanged' }),
      { slim: 'view' },
    );
    expect(unchanged).toMatchObject({
      kind: 'tenon',
      outcome: { ok: true, status: 'unchanged' },
      data: { slim: 'view' },
    });

    const failed = agentToolResult(errorEnvelope('example_tool', 'bad_input', 'Bad input'));
    expect(failed).toMatchObject({
      kind: 'tenon',
      outcome: { ok: false, error: { code: 'bad_input', message: 'Bad input' } },
    });
  });

  test('requires an explicit output-data contract for every Tenon tool', () => {
    expect(MODEL_TOOL_CATALOG).toHaveLength(22);
    expect(MODEL_TOOL_CATALOG.every((contract) => 'outputSchema' in contract)).toBe(true);
    expect(MODEL_TOOL_CATALOG.find((contract) => contract.identity.name === 'update_plan')?.outputSchema)
      .toBeNull();
    expect(MODEL_TOOL_CATALOG.filter((contract) => contract.identity.name !== 'update_plan')
      .every((contract) => contract.outputSchema?.type === 'object')).toBe(true);
  });

});
