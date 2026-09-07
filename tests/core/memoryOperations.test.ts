import { describe, expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import type { TSchema } from 'typebox';
import {
  MEMORY_ERROR_MAX_CHARS,
  MEMORY_INSPECT_SCHEMA,
  MEMORY_MANAGE_SCHEMA,
  MEMORY_INSPECT_OUTPUT_SCHEMA,
  MEMORY_MANAGE_OUTPUT_SCHEMA,
  type MemoryInspectRequest,
  type MemoryManageRequest,
  type MemoryInspectResult,
  type MemoryManageResult,
  type MemoryThreadView,
} from '../../src/core/agent/memoryOperations';
import type { MemoryStatus } from '../../src/core/agent/memory';

const inspect = Compile(MEMORY_INSPECT_SCHEMA as TSchema);
const manage = Compile(MEMORY_MANAGE_SCHEMA as TSchema);
const inspectOutput = Compile(MEMORY_INSPECT_OUTPUT_SCHEMA as TSchema);
const manageOutput = Compile(MEMORY_MANAGE_OUTPUT_SCHEMA as TSchema);
const threadId = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const operationId = `memory:reset:${threadId}`;
const thread: MemoryThreadView = { threadId, mode: 'enabled', revision: 3, appliesAt: 'subsequent_admissions' };
const status: MemoryStatus = {
  featureMode: 'enabled', featureModeGeneration: 1, resetEpoch: 0, memoryVisibilityGeneration: 1,
  lastSuccessfulRunAt: null, lastError: null, pendingJobs: 0, strayTaggedNodeCount: 0,
};

describe('Memory operation schemas', () => {
  test('has provider-compatible object roots with closed nested operation variants', () => {
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

  test('accepts all declared outcome variants without confusing navigation with document creation', () => {
    const inspections: MemoryInspectResult[] = [
      { operation: 'status', status, thread }, { operation: 'status', status, thread: null },
      { operation: 'reset', reset: { operationId, state: 'unknown', admittedAt: null, targetEpoch: null } },
    ];
    for (const result of inspections) expect(inspectOutput.Check({ result })).toBe(true);
    const results: MemoryManageResult[] = [
      ...(['opened', 'unavailable', 'unknown'] as const).map((navigation) => ({ operation: 'open' as const, nodeId: 'search', navigation })),
      { operation: 'set_thread_mode', thread },
      ...(['prepared', 'finalized', 'conflicted', 'unknown'] as const).map((state) => ({
        operation: 'reset' as const, reset: { operationId, state, admittedAt: 100, targetEpoch: 1 },
      })),
    ];
    for (const result of results) expect(manageOutput.Check({ result })).toBe(true);
    expect(manageOutput.Check({ result: { operation: 'open', nodeId: 'search' } })).toBe(false);
    expect(manageOutput.Check({ result: { operation: 'open', nodeId: 'search', navigation: 'sent' } })).toBe(false);
  });

  test('bounds status and refuses private data or ambiguous Thread effect claims', () => {
    const result = { operation: 'status', status, thread };
    for (const field of ['path', 'nodes', 'memoryProse', 'admissionRows']) {
      expect(inspectOutput.Check({ result: { ...result, [field]: 'private' } })).toBe(false);
      expect(inspectOutput.Check({ result: { ...result, status: { ...status, [field]: 'private' } } })).toBe(false);
    }
    expect(inspectOutput.Check({ result: { ...result, status: { ...status, lastError: 'x'.repeat(MEMORY_ERROR_MAX_CHARS) } } })).toBe(true);
    expect(inspectOutput.Check({ result: { ...result, status: { ...status, lastError: 'x'.repeat(MEMORY_ERROR_MAX_CHARS + 1) } } })).toBe(false);
    expect(inspectOutput.Check({ result: { ...result, status: { ...status, pendingJobs: -1 } } })).toBe(false);
    expect(inspectOutput.Check({ result: { ...result, thread: { ...thread, appliesAt: 'immediate' } } })).toBe(false);
    expect(inspectOutput.Check({ result: { ...result, thread: { threadId, mode: 'enabled' } } })).toBe(false);
  });

  test('requires exact admission evidence for known Reset states', () => {
    for (const state of ['prepared', 'finalized', 'conflicted']) {
      for (const reset of [
        { operationId, state, admittedAt: null, targetEpoch: 1 },
        { operationId, state, admittedAt: 100, targetEpoch: null },
        { operationId, state, admittedAt: 100, targetEpoch: 0 },
      ]) {
        expect(inspectOutput.Check({ result: { operation: 'reset', reset } })).toBe(false);
        expect(manageOutput.Check({ result: { operation: 'reset', reset } })).toBe(false);
      }
    }
  });
});
