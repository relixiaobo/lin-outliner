import { expect } from 'bun:test';
import { modelToolContract } from '../../src/core/agent/tools';
import { MAX_TENON_RESULT_DATA_BYTES } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';

/** Direct producer tests must exercise the same output contract as the Kernel. */
export function expectToolOutputContract(tool: string, data: unknown): void {
  const schema = modelToolContract(tool)?.outputSchema;
  if (!schema) throw new Error(`Missing output-data schema for ${tool}`);
  const validator = compileToolParameters(schema as never);
  expect(validator.Errors(data), `${tool} output schema`).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(data)), `${tool} output bytes`)
    .toBeLessThanOrEqual(MAX_TENON_RESULT_DATA_BYTES);
}
