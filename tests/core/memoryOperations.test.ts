import { describe, expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import type { TSchema } from 'typebox';
import {
  MEMORY_INSPECT_SCHEMA,
  MEMORY_MANAGE_SCHEMA,
  type MemoryInspectRequest,
  type MemoryManageRequest,
} from '../../src/core/agent/memoryOperations';

const inspect = Compile(MEMORY_INSPECT_SCHEMA as TSchema);
const manage = Compile(MEMORY_MANAGE_SCHEMA as TSchema);
const threadId = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const operationId = `memory:reset:${threadId}`;
describe('Memory operation schemas', () => {
  test('validates closed window-operation envelopes', () => {
    for (const schema of [MEMORY_INSPECT_SCHEMA, MEMORY_MANAGE_SCHEMA]) {
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not', 'enum']) expect(schema).not.toHaveProperty(keyword);
    }
  });

  test('admits bounded status and exact Reset inspection, independently of management', () => {
    const requests: MemoryInspectRequest[] = [
      { operation: 'status' }, { operation: 'status', threadId }, { operation: 'reset', operationId },
    ];
    for (const request of requests) expect(inspect.Check({ request })).toBe(true);
    for (const request of [
      { operation: 'status', threadId: '' }, { operation: 'status', threadId: 'a'.repeat(257) },
      { operation: 'reset' }, { operation: 'reset', operationId: 3 },
      { operation: 'status', operationId }, { operation: 'reset', operationId, threadId },
      { operation: 'list' }, { operation: 'content' }, { operation: 'status', path: '/private' },
    ]) expect(inspect.Check({ request })).toBe(false);
  });

  test('requires an observed revision for a Thread mode change', () => {
    const requests: MemoryManageRequest[] = [
      { operation: 'open' }, { operation: 'reset' },
      { operation: 'set_thread_mode', mode: 'disabled', expectedRevision: 0 },
      { operation: 'set_thread_mode', threadId, mode: 'enabled', expectedRevision: 5 },
    ];
    for (const request of requests) expect(manage.Check({ request })).toBe(true);
    for (const expectedRevision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
      expect(manage.Check({ request: { operation: 'set_thread_mode', threadId, mode: 'enabled', expectedRevision } })).toBe(false);
    }
    expect(manage.Check({ request: { operation: 'set_thread_mode', mode: 'invalid', expectedRevision: 0 } })).toBe(false);
  });

  test('rejects global setters, content mutations, approval claims, supplied caller identity, and Reset targets', () => {
    for (const request of [
      { operation: 'set_feature_mode', mode: 'disabled' }, { operation: 'reset', approved: true },
      { operation: 'reset', confirmation: 'yes' }, { operation: 'reset', approvalToken: 'forged' },
      { operation: 'reset', threadId }, { operation: 'reset', operationId },
      { operation: 'reset', target: { containerIds: ['node'] } },
      { operation: 'reset', caller: { threadId } }, { operation: 'open', path: '/private' },
      { operation: 'remember', text: 'new memory' }, { operation: 'forget', nodeId: 'node' },
    ]) expect(manage.Check({ request })).toBe(false);
    expect(manage.Check({ request: { operation: 'reset' }, approved: true })).toBe(false);
    expect(manage.Check({ operation: 'reset' })).toBe(false);
  });

});
