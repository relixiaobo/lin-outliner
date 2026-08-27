import { describe, expect, spyOn, test } from 'bun:test';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import { parseAgentCapabilitySettings } from '../../src/main/agent/capabilities/agentCapabilityRules';
import type { AgentSkillRuntime } from '../../src/main/agent/capabilities/agentSkills';
import type { PersistedSubagentToolPolicy } from '../../src/main/agent/capabilities/subagentToolPolicy';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

describe('Subagent ToolRuntime policy', () => {
  test('does not consult the execution ledger for root Threads', async () => {
    let executionReads = 0;
    const runtime = new ToolRuntime({
      ...runtimeService(CHILD_POLICY),
      subagentExecution: () => {
        executionReads += 1;
        return null;
      },
    } as unknown as ThreadService, {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    await runtime.createTools(runtimeContext(false));
    await runtime.prepareProviderContext(runtimeContext(false, []));

    expect(executionReads).toBe(0);
  });

  test('fails closed before provider preparation when a delegated child policy is not committed', async () => {
    const cases = [
      {
        label: 'missing execution',
        execution: null,
        message: 'has no execution record',
      },
      {
        label: 'pending initial admission',
        execution: {
          agentType: 'custom-reviewer',
          initialAdmissionState: 'pending',
          toolPolicy: CHILD_POLICY,
        },
        message: 'initial admission is not committed',
      },
      {
        label: 'missing tool policy',
        execution: {
          agentType: 'custom-reviewer',
          initialAdmissionState: 'committed',
        },
        message: 'has no persisted tool policy',
      },
    ] as const;

    for (const admissionCase of cases) {
      for (const entrypoint of ['createTools', 'prepareProviderContext'] as const) {
        let preparationCalls = 0;
        const service = runtimeServiceWithExecution(admissionCase.execution, () => {
          preparationCalls += 1;
        });
        const runtime = new ToolRuntime(service, {
          skillRuntime: () => {
            preparationCalls += 1;
            return undefined;
          },
          capabilityTools: () => {
            preparationCalls += 1;
            return runtimeSchemaTools();
          },
          dynamicTools: () => {
            preparationCalls += 1;
            return [];
          },
          assembleRegistry: true,
        });
        const context = runtimeContext(true, ['skill']);

        const operation = entrypoint === 'createTools'
          ? runtime.createTools(context)
          : runtime.prepareProviderContext(context);

        await expect(operation).rejects.toThrow(admissionCase.message);
        expect(preparationCalls, `${admissionCase.label} through ${entrypoint}`).toBe(0);
      }
    }
  });

  test('degrades unavailable child dynamic and extension tools without weakening the root invariant', async () => {
    const extension = extensionContract('docs', 'lookup');
    const dynamic = runtimeTool('unknown_dynamic');
    const childRuntime = new ToolRuntime(runtimeService(CHILD_POLICY, [extension]), {
      capabilityTools: runtimeSchemaTools,
      dynamicTools: () => [dynamic],
      assembleRegistry: true,
    });
    const warnings: string[] = [];
    const warning = spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.map(String).join(' '));
    });

    const childTools = await childRuntime.createTools(runtimeContext(true))
      .finally(() => warning.mockRestore());

    expect(childTools.map((tool) => tool.name)).not.toContain('unknown_dynamic');
    expect(childTools.map((tool) => tool.name)).not.toContain('docs__lookup');
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Skipping dynamic model tool without a canonical contract: unknown_dynamic'),
      expect.stringContaining('Skipping extension model tool without a runtime implementation: docs.lookup'),
    ]));

    const rootRuntime = new ToolRuntime(runtimeService(CHILD_POLICY, [extension]), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });
    await expect(rootRuntime.createTools(runtimeContext(false)))
      .rejects.toThrow('Enabled extension model tool has no runtime implementation: docs.lookup');
  });

  test('rejects a non-empty Role list that resolves only to unknown or policy-unavailable tools', async () => {
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      requestedTools: ['missing_tool', 'request_user_input'],
    };
    const runtime = new ToolRuntime(runtimeService(policy), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    let failure: unknown;

    try {
      await runtime.createTools(runtimeContext(true));
    } catch (error) {
      failure = error;
    } finally {
      warning.mockRestore();
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Agent 'custom-reviewer' would be spawned with zero tools");
    expect((failure as Error).message).toContain('unrecognized [missing_tool]');
    expect((failure as Error).message)
      .toContain('not available under this Agent policy [request_user_input]');
  });

  test('rejects an explicitly empty Role tool list before provider preparation', async () => {
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      requestedTools: [],
    };
    const runtime = new ToolRuntime(runtimeService(policy), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    await expect(runtime.createTools(runtimeContext(true)))
      .rejects.toThrow(
        "Agent 'custom-reviewer' would be spawned with zero tools — refusing. "
        + 'Its tools list resolved to nothing: no admitted tools.',
      );
  });

  test('keeps an isolated Skill with an empty requested-tool ceiling tool-free', async () => {
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      requestedTools: [],
    };
    const runtime = new ToolRuntime(runtimeServiceWithExecution({
      agentType: 'isolated-skill',
      initialAdmissionState: 'committed',
      toolPolicy: policy,
    }), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    expect(await runtime.createTools(runtimeContext(true))).toEqual([]);
  });

  test('treats a Role wildcard as inheriting the resolved configuration ceiling', async () => {
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      requestedTools: ['*'],
    };
    const runtime = new ToolRuntime(runtimeService(policy), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    const tools = await runtime.createTools(runtimeContext(true, ['file_read', 'file_grep']));

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['file_read', 'file_grep']));
  });

  test('does not refresh Skill catalog evidence for Explore or Plan children', async () => {
    for (const kind of ['explore', 'plan'] as const) {
      let runtimeReads = 0;
      let persistedCatalogs = 0;
      const policy: PersistedSubagentToolPolicy = {
        ...CHILD_POLICY,
        kind,
      };
      const runtime = new ToolRuntime(runtimeService(policy), {
        skillRuntime: () => {
          runtimeReads += 1;
          return {} as AgentSkillRuntime;
        },
      });
      const context = runtimeContext(true, ['skill']) as TurnExecutionContext;
      const specializedContext = {
        ...context,
        persistSkillCatalog: async () => {
          persistedCatalogs += 1;
          return null;
        },
      } as TurnExecutionContext;

      await runtime.prepareProviderContext(specializedContext);

      expect(runtimeReads).toBe(0);
      expect(persistedCatalogs).toBe(0);
    }
  });

  test('keeps specialized Bash visible while rejecting repository mutations before execution', async () => {
    for (const kind of ['explore', 'plan'] as const) {
      let executions = 0;
      const policy: PersistedSubagentToolPolicy = { ...CHILD_POLICY, kind };
      const runtime = new ToolRuntime(runtimeService(policy), {
        capabilityTools: () => runtimeSchemaTools((name) => {
          if (name === 'bash') executions += 1;
        }),
        capabilityConfig: { blocks: [] },
        assembleRegistry: true,
      });
      const tools = await runtime.createTools(runtimeContext(true, ['bash']));
      const bash = tools.find((tool) => tool.name === 'bash');
      if (!bash) throw new Error('Expected specialized Bash tool.');

      await bash.execute('read', { command: 'git status --short' });
      await bash.execute('find', { command: 'find . -type f -name "*.ts"' });
      await bash.execute('find-name', { command: "find . -type f -name '-exec'" });
      expect(executions).toBe(3);

      for (const command of [
        'printf changed > tracked.txt',
        'sed -i.bak s/old/new/ tracked.txt',
        'git commit -am changed',
        'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'changed\')"',
        'find . -exec touch changed.txt {} \\;',
        'find . -execdir touch changed.txt {} \\;',
        'find . -ok touch changed.txt {} \\;',
        'find . -okdir touch changed.txt {} \\;',
        "find . '-exec' touch changed.txt {} \\;",
        'find . -fprint changed.txt',
      ]) {
        const result = await bash.execute('write', { command });
        expect(result.details).toMatchObject({
          error: {
            code: 'operation_unavailable',
            details: { reason: 'subagent_repository_mutation_restricted' },
          },
        });
      }
      expect(executions).toBe(3);
    }
  });

  test('keeps inspection tools visible while enforcing a read-only action ceiling at execution', async () => {
    let executions = 0;
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      readOnly: true,
    };
    const runtime = new ToolRuntime(runtimeService(policy), {
      capabilityTools: () => runtimeSchemaTools(() => { executions += 1; }),
      capabilityConfig: { blocks: [] },
      assembleRegistry: true,
    });
    const tools = await runtime.createTools(runtimeContext(true));
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'file_read', 'file_glob', 'file_grep', 'bash', 'web_search', 'web_fetch',
      'agent', 'skill',
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['file_edit', 'file_write', 'file_delete']));

    const bash = tools.find((tool) => tool.name === 'bash');
    if (!bash) throw new Error('Expected read-only Bash tool.');
    await bash.execute('read', { command: 'rg -n "needle" src' });
    expect(executions).toBe(1);

    for (const command of [
      'printf changed > tracked.txt',
      'python3 -c "open(\'tracked.txt\', \'w\').write(\'changed\')"',
      'node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'changed\')"',
      'curl -X POST https://example.test/items -d value=changed',
      'outline add @today changed',
    ]) {
      const result = await bash.execute('blocked', { command });
      expect(result.details).toMatchObject({
        error: {
          code: 'operation_unavailable',
          details: { reason: 'subagent_read_only_restricted' },
        },
        capabilityAudit: {
          behavior: 'unavailable',
          source: 'subagent_policy',
          code: 'subagent_read_only_restricted',
        },
      });
    }
    expect(executions).toBe(1);
  });

  test('keeps specialized extension reads while rejecting declared repository mutations before execution', async () => {
    for (const kind of ['explore', 'plan'] as const) {
      let readExecutions = 0;
      let writeExecutions = 0;
      let codeExecutions = 0;
      const policy: PersistedSubagentToolPolicy = { ...CHILD_POLICY, kind };
      const readExtension = extensionContract('docs', 'lookup', ['file.read.local_path']);
      const writeExtension = extensionContract('docs', 'rewrite', ['file.write.local_path']);
      const codeExtension = extensionContract('docs', 'run_code', ['shell.local_code_execution']);
      const runtime = new ToolRuntime(runtimeService(policy, [readExtension, writeExtension, codeExtension]), {
        capabilityTools: () => runtimeSchemaTools(),
        dynamicTools: () => [
          runtimeTool('docs__lookup', () => { readExecutions += 1; }),
          runtimeTool('docs__rewrite', () => { writeExecutions += 1; }),
          runtimeTool('docs__run_code', () => { codeExecutions += 1; }),
        ],
        capabilityConfig: { blocks: [] },
        assembleRegistry: true,
      });
      const tools = await runtime.createTools(runtimeContext(true));
      const lookup = tools.find((tool) => tool.name === 'docs__lookup');
      const rewrite = tools.find((tool) => tool.name === 'docs__rewrite');
      const runCode = tools.find((tool) => tool.name === 'docs__run_code');
      if (!lookup || !rewrite || !runCode) throw new Error('Expected specialized extension tools.');

      const readResult = await lookup.execute('lookup', {});
      expect(readResult.details).toMatchObject({
        ok: true,
        capabilityAudit: {
          behavior: 'allow',
          descriptors: [expect.objectContaining({ actionKind: 'file.read.local_path' })],
        },
      });
      expect(readExecutions).toBe(1);

      const writeResult = await rewrite.execute('rewrite', {});
      expect(writeResult.details).toMatchObject({
        error: {
          code: 'operation_unavailable',
          details: { reason: 'subagent_repository_mutation_restricted' },
        },
        capabilityAudit: {
          behavior: 'unavailable',
          descriptors: [expect.objectContaining({ actionKind: 'file.write.local_path' })],
        },
      });
      expect(writeExecutions).toBe(0);

      const codeResult = await runCode.execute('run-code', {});
      expect(codeResult.details).toMatchObject({
        error: {
          code: 'operation_unavailable',
          details: { reason: 'subagent_repository_mutation_restricted' },
        },
        capabilityAudit: {
          behavior: 'unavailable',
          descriptors: [expect.objectContaining({ actionKind: 'shell.local_code_execution' })],
        },
      });
      expect(codeExecutions).toBe(0);
    }
  });

  test('fails closed for specialized extension tools whose action descriptors are unclassified', async () => {
    for (const kind of ['explore', 'plan'] as const) {
      let executions = 0;
      const policy: PersistedSubagentToolPolicy = { ...CHILD_POLICY, kind };
      const unclassifiedExtension = extensionContract('docs', 'unclassified', []);
      const runtime = new ToolRuntime(runtimeService(policy, [unclassifiedExtension]), {
        capabilityTools: () => runtimeSchemaTools(),
        dynamicTools: () => [runtimeTool('docs__unclassified', () => { executions += 1; })],
        capabilityConfig: { blocks: [] },
        assembleRegistry: true,
      });
      const tool = (await runtime.createTools(runtimeContext(true)))
        .find((candidate) => candidate.name === 'docs__unclassified');
      if (!tool) throw new Error('Expected unclassified extension tool.');

      const result = await tool.execute('unclassified', {});

      expect(result.details).toMatchObject({
        error: {
          code: 'operation_unavailable',
          details: { reason: 'subagent_repository_mutation_restricted' },
        },
        capabilityAudit: {
          behavior: 'unavailable',
          descriptors: [expect.objectContaining({ actionKind: 'shell.unknown' })],
        },
      });
      expect(executions).toBe(0);
    }
  });

  test('enforces explicit action blocks from resolved extension contracts for root and child tools', async () => {
    const extension = extensionContract('docs', 'lookup');
    for (const child of [false, true]) {
      let executions = 0;
      const runtime = new ToolRuntime(runtimeService(CHILD_POLICY, [extension]), {
        capabilityTools: () => runtimeSchemaTools(),
        dynamicTools: () => [runtimeTool('docs__lookup', () => { executions += 1; })],
        capabilityConfig: parseAgentCapabilitySettings({ blocks: ['Action(web.fetch)'] }),
        assembleRegistry: true,
      });
      const lookup = (await runtime.createTools(runtimeContext(child)))
        .find((tool) => tool.name === 'docs__lookup');
      if (!lookup) throw new Error('Expected extension lookup tool.');

      const result = await lookup.execute('lookup', {});

      expect(result.details).toMatchObject({
        error: {
          code: 'operation_unavailable',
          details: { reason: 'user_blocked' },
        },
        capabilityAudit: {
          behavior: 'unavailable',
          descriptors: [expect.objectContaining({ actionKind: 'web.fetch' })],
        },
      });
      expect(executions).toBe(0);
    }
  });
});

const CHILD_POLICY: PersistedSubagentToolPolicy = {
  kind: 'general-purpose',
  runInBackground: false,
  worktree: false,
  readOnly: false,
  allowNesting: true,
  requestedTools: null,
};

function runtimeService(
  toolPolicy: PersistedSubagentToolPolicy,
  extensionTools: readonly ModelToolContract[] = [],
): ThreadService {
  return runtimeServiceWithExecution({
    agentType: 'custom-reviewer',
    initialAdmissionState: 'committed',
    toolPolicy,
  }, undefined, extensionTools);
}

function runtimeServiceWithExecution(
  execution: {
    readonly agentType?: string;
    readonly initialAdmissionState?: 'pending' | 'committed';
    readonly toolPolicy?: PersistedSubagentToolPolicy;
  } | null,
  onPreparation?: () => void,
  extensionTools: readonly ModelToolContract[] = [],
): ThreadService {
  return {
    collaborationToolContributions: () => {
      onPreparation?.();
      return [];
    },
    extensionToolContributions: async () => {
      onPreparation?.();
      return extensionTools.length === 0
        ? []
        : [{ extensionId: 'extension-probe', tools: extensionTools }];
    },
    notifyToolStarted: async () => {},
    notifyToolCompleted: async () => {},
    subagentExecution: () => execution,
  } as unknown as ThreadService;
}

function runtimeContext(
  child: boolean,
  tools: readonly string[] = MODEL_TOOL_CATALOG.map((contract) => canonicalModelToolKey(contract.identity)),
): TurnExecutionContext {
  const configuration: EffectiveThreadConfiguration = {
    profileName: 'subagent-tool-policy-test',
    developerInstructions: [],
    model: 'test-model',
    reasoningEffort: 'medium',
    tools,
    skills: [],
    preloadedSkills: [],
    plugins: ['extension-probe'],
    mcpServers: [],
  };
  return {
    thread: {
      id: child
        ? '00000000-0000-7000-8000-000000000003'
        : '00000000-0000-7000-8000-000000000001',
      parentThreadId: child ? '00000000-0000-7000-8000-000000000001' : null,
      cwd: process.cwd(),
    },
    turn: { id: '00000000-0000-7000-8000-000000000002' },
    configuration,
  } as unknown as TurnExecutionContext;
}

function runtimeSchemaTools(onExecute?: (name: string) => void): AgentTool[] {
  return MODEL_TOOL_CATALOG.flatMap((contract) => contract.inputSchema === null
    ? [runtimeTool(canonicalModelToolKey(contract.identity), () => onExecute?.(canonicalModelToolKey(contract.identity)))]
    : []);
}

function runtimeTool(name: string, onExecute?: () => void): AgentTool {
  return {
    name,
    label: name,
    description: `Runtime ${name} tool.`,
    parameters: { type: 'object', additionalProperties: false } as never,
    executionMode: 'sequential',
    execute: async () => {
      onExecute?.();
      return {
        content: [{ type: 'text', text: 'ok' }],
        details: { ok: true },
      };
    },
  };
}

function extensionContract(
  namespace: string,
  name: string,
  actionKinds: ModelToolContract['actionKinds'] = ['web.fetch'],
): ModelToolContract {
  return {
    identity: { namespace, name },
    description: 'Test extension tool.',
    scope: 'anyThread',
    schemaOwner: 'extension',
    inputSchema: { type: 'object', additionalProperties: false },
    actionKinds,
  };
}
