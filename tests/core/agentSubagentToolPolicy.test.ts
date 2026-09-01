import { describe, expect, test } from 'bun:test';
import {
  MODEL_TOOL_CATALOG,
  modelToolContract,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import {
  filterSubagentToolContracts,
  filterSubagentToolKeys,
  resolveSubagentToolRequest,
  subagentBashExecutionAllowed,
  subagentToolExecutionAllowed,
} from '../../src/main/agent/capabilities/subagentToolPolicy';

const foreground = {
  kind: 'general-purpose' as const,
  runInBackground: false,
  worktree: false,
  readOnly: false,
  allowNesting: true,
};

describe('Subagent tool policy', () => {
  test('removes root-only controls from every Agent pool', () => {
    const keys = filterSubagentToolContracts(MODEL_TOOL_CATALOG, foreground).map(toolKey);
    expect(keys).not.toContain('request_user_input');
    expect(keys).not.toContain('automation_update');
  });

  test('keeps the ordinary tool catalog stable across worktree isolation', () => {
    const regular = filterSubagentToolContracts(MODEL_TOOL_CATALOG, foreground).map(toolKey);
    const worktree = filterSubagentToolContracts(MODEL_TOOL_CATALOG, {
      ...foreground,
      worktree: true,
    }).map(toolKey);
    expect(regular).toEqual(expect.arrayContaining(['file_read', 'file_write', 'bash', 'skill']));
    expect(worktree).toEqual(regular);
  });

  test('removes repository mutation and nesting from explore and plan pools', () => {
    for (const kind of ['explore', 'plan'] as const) {
      const keys = filterSubagentToolContracts(MODEL_TOOL_CATALOG, {
        ...foreground,
        kind,
      }).map(toolKey);
      const forbidden = [
        'agent',
        'file_edit',
        'file_write',
        'file_delete',
        'generate_image',
      ];
      for (const key of forbidden) expect(keys).not.toContain(key);
      expect(keys).toEqual(expect.arrayContaining(['file_read', 'bash', 'web_fetch', 'skill']));
    }
  });

  test('admits only classified repository inspection through specialized Bash', () => {
    for (const kind of ['explore', 'plan'] as const) {
      const policy = { ...foreground, kind };
      expect(subagentBashExecutionAllowed(policy, ['shell.read_search'])).toBe(true);
      expect(subagentBashExecutionAllowed(policy, ['shell.read_search', 'shell.background_process'])).toBe(true);
      expect(subagentBashExecutionAllowed(policy, ['file.edit.local_path'])).toBe(false);
      expect(subagentBashExecutionAllowed(policy, ['shell.local_code_execution'])).toBe(false);
      expect(subagentBashExecutionAllowed(policy, ['shell.unknown'])).toBe(false);
    }
    expect(subagentBashExecutionAllowed(foreground, ['file.edit.local_path'])).toBe(true);
    expect(subagentBashExecutionAllowed({ ...foreground, worktree: true }, ['outline.edit'])).toBe(false);
    expect(subagentBashExecutionAllowed({ ...foreground, worktree: true }, ['shell.local_code_execution'])).toBe(true);
  });

  test('applies stdin consumer policy before constrained Bash execution', () => {
    const constrained = [
      { ...foreground, worktree: true },
      { ...foreground, readOnly: true },
      { ...foreground, kind: 'explore' as const },
      { ...foreground, kind: 'plan' as const },
    ];
    for (const policy of constrained) {
      expect(subagentBashExecutionAllowed(policy, ['shell.read_search'], 'executable')).toBe(false);
      expect(subagentBashExecutionAllowed(policy, ['shell.read_search'], 'unknown')).toBe(false);
    }
    expect(subagentBashExecutionAllowed(
      { ...foreground, worktree: true },
      ['outline.read'],
      'registered-data',
    )).toBe(true);
    expect(subagentBashExecutionAllowed(
      { ...foreground, worktree: true },
      ['outline.edit'],
      'registered-data',
    )).toBe(false);
    expect(subagentBashExecutionAllowed(foreground, ['shell.unknown'], 'unknown')).toBe(true);
    expect(subagentBashExecutionAllowed(foreground, ['shell.local_code_execution'], 'executable')).toBe(true);
  });

  test('fails closed on unclassified read-only actions while preserving inspection and host control', () => {
    const policy = { ...foreground, readOnly: true };
    const keys = filterSubagentToolContracts(MODEL_TOOL_CATALOG, policy).map(toolKey);
    expect(keys).toEqual(expect.arrayContaining([
      'file_read',
      'file_glob',
      'bash',
      'agent',
      'skill',
      'thread_search',
      'thread_read',
    ]));
    expect(keys).not.toEqual(expect.arrayContaining(['file_edit', 'file_write', 'file_delete']));
    expect(subagentBashExecutionAllowed(policy, [])).toBe(false);
    expect(subagentBashExecutionAllowed(policy, ['shell.read_search'])).toBe(true);
    expect(subagentBashExecutionAllowed(policy, ['shell.unknown'])).toBe(false);
    expect(subagentToolExecutionAllowed(policy, [])).toBe(false);
    expect(subagentToolExecutionAllowed(policy, ['web.fetch'])).toBe(true);
    expect(subagentToolExecutionAllowed(policy, ['thread.history.search'])).toBe(true);
    expect(subagentToolExecutionAllowed(policy, ['thread.history.read'])).toBe(true);
    expect(subagentToolExecutionAllowed(policy, ['external.message.send'])).toBe(false);
  });

  test('keeps extension tools visible while enforcing specialized mutation actions at execution', () => {
    for (const kind of ['explore', 'plan'] as const) {
      const policy = { ...foreground, kind };
      expect(subagentToolExecutionAllowed(policy, [])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['file.read.local_path'])).toBe(true);
      expect(subagentToolExecutionAllowed(policy, ['web.fetch'])).toBe(true);
      expect(subagentToolExecutionAllowed(policy, ['outline.read'])).toBe(true);
      expect(subagentToolExecutionAllowed(policy, ['file.read.local_path', 'file.write.local_path'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['outline.edit'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.local_code_execution'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.project_script'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.dependency_install'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.destructive_cleanup'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.unknown'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['git.publish_remote'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['deploy.publish_remote'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['external.message.send'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['shell.network_write'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['agent.subagent.send'])).toBe(false);
      expect(subagentToolExecutionAllowed(policy, ['future.action' as never])).toBe(false);
    }
    expect(subagentToolExecutionAllowed(foreground, ['file.write.local_path'])).toBe(true);
  });

  test('uses the background allowlist while preserving MCP contracts', () => {
    const mcp = extensionContract('docs', 'lookup');
    const keys = filterSubagentToolContracts([...MODEL_TOOL_CATALOG, mcp], {
      ...foreground,
      runInBackground: true,
    }).map(toolKey);
    for (const forbidden of ['update_plan', 'get_goal', 'generate_image']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toEqual(expect.arrayContaining(['file_read', 'file_write', 'bash', 'web_fetch', 'skill', 'docs.lookup']));
  });

  test('filters canonical keys through the same contract classifier and drops unknown entries', () => {
    const keys = filterSubagentToolKeys([
      'file_read',
      'retired_tool',
      'agent',
      'missing_tool',
    ], {
      ...foreground,
      allowNesting: false,
    });
    expect(keys).toEqual(['file_read']);
  });

  test('treats a Role wildcard as the resolved parent tool ceiling', () => {
    expect(resolveSubagentToolRequest(['*'], MODEL_TOOL_CATALOG)).toEqual({
      requestedTools: null,
      recognizedTools: [],
      unrecognizedTools: [],
    });
    expect(resolveSubagentToolRequest(['file_read', '*'], MODEL_TOOL_CATALOG)).toEqual({
      requestedTools: null,
      recognizedTools: [],
      unrecognizedTools: [],
    });
  });

  test('classifies new core tools by capability instead of relying on known names', () => {
    const rootOnly = coreContract('future_prompt', ['agent.user_input.request']);
    const outlineMutation = coreContract('future_outline_mutation', ['outline.edit']);
    const fileMutation = coreContract('future_file_mutation', ['file.write.local_path']);
    const nesting = coreContract('future_agent', ['agent.subagent.spawn']);
    const tools = [rootOnly, outlineMutation, fileMutation, nesting];

    expect(filterSubagentToolContracts(tools, foreground).map(toolKey)).toEqual([
      'future_outline_mutation',
      'future_file_mutation',
      'future_agent',
    ]);
    expect(filterSubagentToolContracts(tools, { ...foreground, worktree: true }).map(toolKey))
      .toEqual(['future_file_mutation', 'future_agent']);
    expect(filterSubagentToolContracts(tools, { ...foreground, kind: 'explore' }).map(toolKey))
      .toEqual([]);
    expect(filterSubagentToolContracts(tools, { ...foreground, allowNesting: false }).map(toolKey))
      .not.toContain('future_agent');
    expect(filterSubagentToolContracts(tools, { ...foreground, runInBackground: true })).toEqual([]);
  });
});

function toolKey(contract: ModelToolContract): string {
  return contract.identity.namespace
    ? `${contract.identity.namespace}.${contract.identity.name}`
    : contract.identity.name;
}

function extensionContract(namespace: string, name: string): ModelToolContract {
  return {
    identity: { namespace, name },
    description: 'Test MCP tool.',
    scope: 'anyThread',
    schemaOwner: 'extension',
    inputSchema: { type: 'object' },
    actionKinds: modelToolContract('web_fetch')!.actionKinds,
  };
}

function coreContract(
  name: string,
  actionKinds: ModelToolContract['actionKinds'],
): ModelToolContract {
  return {
    identity: { namespace: null, name },
    description: 'Future core tool.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: { type: 'object' },
    actionKinds,
  };
}
