import { describe, expect, test } from 'bun:test';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  type ModelToolActionKind,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import {
  delegatedBashExecutionAllowed,
  delegatedToolExecutionAllowed,
  filterDelegatedToolContracts,
} from '../../src/main/agent/delegation';

const GENERAL_WRITE = { profile: 'general', access: 'workspace-write' } as const;
const GENERAL_READ = { profile: 'general', access: 'read-only' } as const;

describe('delegated tool policy', () => {
  test('hard-blocks recursive, interactive, root-control, task-control, and history tools', () => {
    const keys = filterDelegatedToolContracts(MODEL_TOOL_CATALOG, GENERAL_WRITE).map(canonicalModelToolKeyForTest);
    for (const blocked of [
      'task_status',
      'task_stop',
      'request_user_input',
      'automation_update',
      'get_goal',
      'create_goal',
      'update_goal',
      'thread_search',
      'thread_read',
    ]) expect(keys).not.toContain(blocked);
    expect(keys).toEqual(expect.arrayContaining([
      'file_read', 'file_write', 'bash', 'web_fetch', 'skill', 'update_plan',
    ]));
  });

  test('derives read-only profiles from action kinds while preserving inline Skills and Session plans', () => {
    for (const profile of ['general', 'explore', 'plan'] as const) {
      const keys = filterDelegatedToolContracts(MODEL_TOOL_CATALOG, {
        profile,
        access: 'read-only',
      }).map(canonicalModelToolKeyForTest);
      expect(keys).toEqual(expect.arrayContaining([
        'file_read', 'file_glob', 'file_grep', 'bash', 'web_search', 'web_fetch', 'skill', 'update_plan',
      ]));
      expect(keys).not.toEqual(expect.arrayContaining([
        'file_edit', 'file_write', 'file_delete', 'generate_image',
      ]));
    }
  });

  test('rejects invalid profile and access combinations at the policy boundary', () => {
    for (const profile of ['explore', 'plan'] as const) {
      expect(() => filterDelegatedToolContracts(MODEL_TOOL_CATALOG, {
        profile,
        access: 'workspace-write',
      })).toThrow(`${profile} delegation requires read-only access`);
    }
  });

  test('classifies future and extension tools without a name allowlist', () => {
    const tools = [
      contract('docs', 'lookup', ['web.fetch']),
      contract('docs', 'rewrite', ['file.write.local_path']),
      contract(null, 'future_control', ['task.stop']),
      contract(null, 'future_unknown', []),
    ];
    expect(filterDelegatedToolContracts(tools, GENERAL_WRITE).map(canonicalModelToolKeyForTest))
      .toEqual(['docs.lookup', 'docs.rewrite']);
    expect(filterDelegatedToolContracts(tools, GENERAL_READ).map(canonicalModelToolKeyForTest))
      .toEqual(['docs.lookup']);
  });

  test('fails closed at execution for empty, unclassified, or hard-blocked action sets', () => {
    expect(delegatedToolExecutionAllowed(GENERAL_WRITE, [])).toBe(false);
    expect(delegatedToolExecutionAllowed(GENERAL_WRITE, ['task.stop'])).toBe(false);
    expect(delegatedToolExecutionAllowed(GENERAL_WRITE, ['file.write.local_path'])).toBe(true);
    expect(delegatedToolExecutionAllowed(GENERAL_READ, ['file.read.local_path'])).toBe(true);
    expect(delegatedToolExecutionAllowed(GENERAL_READ, ['file.write.local_path'])).toBe(false);
    expect(delegatedToolExecutionAllowed(GENERAL_READ, ['future.action' as ModelToolActionKind])).toBe(false);
  });

  test('keeps Bash foreground and applies the access ceiling to every classified invocation', () => {
    expect(delegatedBashExecutionAllowed(GENERAL_WRITE, ['shell.local_code_execution'], 'absent', false))
      .toBe(true);
    expect(delegatedBashExecutionAllowed(GENERAL_WRITE, ['shell.read_search'], 'absent', true))
      .toBe(false);
    expect(delegatedBashExecutionAllowed(GENERAL_WRITE, ['shell.background_process'], 'absent', false))
      .toBe(false);
    expect(delegatedBashExecutionAllowed(GENERAL_READ, ['shell.read_search'], 'registered-data', false))
      .toBe(true);
    expect(delegatedBashExecutionAllowed(GENERAL_READ, ['shell.read_search'], 'executable', false))
      .toBe(false);
    expect(delegatedBashExecutionAllowed(GENERAL_READ, ['shell.unknown'], 'absent', false))
      .toBe(false);
  });
});

function canonicalModelToolKeyForTest(contract: ModelToolContract): string {
  return canonicalModelToolKey(contract.identity);
}

function contract(
  namespace: string | null,
  name: string,
  actionKinds: readonly ModelToolActionKind[],
): ModelToolContract {
  return {
    identity: { namespace, name },
    description: 'Test tool.',
    scope: 'anyThread',
    schemaOwner: namespace === null ? 'core' : 'extension',
    inputSchema: { type: 'object' },
    actionKinds,
  };
}
