import { describe, expect, spyOn, test } from 'bun:test';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { AgentSkillRuntime } from '../../src/main/agent/capabilities/agentSkills';
import type { PersistedSubagentToolPolicy } from '../../src/main/agent/capabilities/subagentToolPolicy';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

describe('Subagent ToolRuntime policy', () => {
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

  test('keeps an explicitly empty Role tool list empty without treating it as invalid', async () => {
    const policy: PersistedSubagentToolPolicy = {
      ...CHILD_POLICY,
      requestedTools: [],
    };
    const runtime = new ToolRuntime(runtimeService(policy), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    expect(await runtime.createTools(runtimeContext(true))).toEqual([]);
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
});

const CHILD_POLICY: PersistedSubagentToolPolicy = {
  kind: 'general-purpose',
  runInBackground: false,
  worktree: false,
  allowNesting: true,
  requestedTools: null,
};

function runtimeService(
  toolPolicy: PersistedSubagentToolPolicy,
  extensionTools: readonly ModelToolContract[] = [],
): ThreadService {
  return {
    collaborationToolContributions: () => [],
    extensionToolContributions: async () => extensionTools.length === 0
      ? []
      : [{ extensionId: 'extension-probe', tools: extensionTools }],
    subagentExecution: () => ({
      agentType: 'custom-reviewer',
      toolPolicy,
    }),
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

function runtimeSchemaTools(): AgentTool[] {
  return MODEL_TOOL_CATALOG.flatMap((contract) => contract.inputSchema === null
    ? [runtimeTool(canonicalModelToolKey(contract.identity))]
    : []);
}

function runtimeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Runtime ${name} tool.`,
    parameters: { type: 'object', additionalProperties: false } as never,
    executionMode: 'sequential',
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      details: { ok: true },
    }),
  };
}

function extensionContract(namespace: string, name: string): ModelToolContract {
  return {
    identity: { namespace, name },
    description: 'Test extension tool.',
    scope: 'anyThread',
    schemaOwner: 'extension',
    inputSchema: { type: 'object', additionalProperties: false },
    actionKinds: ['web.fetch'],
  };
}
