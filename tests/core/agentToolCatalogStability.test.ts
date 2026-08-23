import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  providerToolSchemaFailure,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

describe('canonical provider tool catalog', () => {
  test('passes the isolated byte-stability probe', async () => {
    const probe = Bun.spawn([
      process.execPath,
      'test',
      join(import.meta.dir, '..', 'fixtures', 'agentToolCatalogStability.test.ts'),
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
    expect(exitCode).toBe(0);
  });

  test('compiles every static model-tool schema', () => {
    const failures: string[] = [];
    for (const contract of MODEL_TOOL_CATALOG) {
      if (contract.inputSchema === null) continue;
      try {
        compileToolParameters(contract.inputSchema as never);
      } catch (error) {
        failures.push(`${canonicalModelToolKey(contract.identity)}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('offers every static model-tool schema to providers as an object-rooted schema', () => {
    const unsendable = MODEL_TOOL_CATALOG
      .filter((contract) => contract.inputSchema !== null)
      .map((contract) => `${canonicalModelToolKey(contract.identity)}: ${providerToolSchemaFailure(contract.inputSchema)}`)
      .filter((entry) => !entry.endsWith(': null'));
    expect(unsendable).toEqual([]);
  });

  test('names every root shape a provider answers with HTTP 400', () => {
    // All of these compile, which is exactly why the compile guard waved
    // `automation_update` through for two weeks while OpenAI answered `schema
    // must be a JSON Schema of 'type: "object"', got 'type: null'` on every root
    // Turn that offered the tool. A root union is refused for the same reason
    // Some provider tools normalize mutually exclusive argument groups at runtime.
    const rootUnion = { oneOf: [{ type: 'object', properties: {} }] };
    expect(() => compileToolParameters(rootUnion as never)).not.toThrow();
    expect(providerToolSchemaFailure(rootUnion)).toBe('schema root must be \'type: "object"\', got null');
    expect(providerToolSchemaFailure({ type: 'string' })).toBe('schema root must be \'type: "object"\', got "string"');
    expect(providerToolSchemaFailure([{ type: 'object' }])).toBe('schema must be a JSON Schema object');
    expect(providerToolSchemaFailure(null)).toBe('schema must be a JSON Schema object');
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'enum', 'not']) {
      const schema = { type: 'object', properties: {}, [keyword]: keyword === 'not' ? {} : [] };
      expect(() => compileToolParameters(schema as never)).not.toThrow();
      expect(providerToolSchemaFailure(schema)).toBe(`schema root must not carry "${keyword}"`);
    }
    // Nested unions stay legal: only the root is restricted.
    expect(providerToolSchemaFailure({
      type: 'object',
      properties: { effort: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    })).toBeNull();
  });

  test.each([
    ['cannot compile', { type: 'object', patternProperties: { '[': { type: 'string' } } }],
    ['is not object-rooted', { oneOf: [{ type: 'object' }] }],
    ['carries a root union', { type: 'object', properties: {}, anyOf: [{ required: ['a'] }] }],
  ])('fails closed when a Core capability schema %s', async (_label, parameters) => {
    const tools = runtimeSchemaTools().map((tool) => tool.name === 'bash'
      ? { ...tool, parameters: parameters as never }
      : tool);
    const runtime = new ToolRuntime(runtimeService(), {
      capabilityTools: () => tools,
      assembleRegistry: true,
    });

    await expect(runtime.createTools(RUNTIME_CONTEXT)).rejects.toThrow(
      'Runtime model-tool schema is invalid: bash',
    );
  });

  test('fails closed for a host-owned schema a dynamic factory registered', async () => {
    // `automation_update` reaches the runtime through `dynamicTools`, the same
    // channel MCP-backed and extension tools use. Ownership decides: its
    // contract is Core-owned, so an unsendable schema is a structural failure
    // rather than a `console.warn` and a tool that quietly disappears — which is
    // the failure this whole guard exists to prevent, for the tool it happened to.
    const runtime = new ToolRuntime(runtimeService(), {
      capabilityTools: runtimeSchemaTools,
      dynamicTools: () => [{
        name: 'automation_update',
        label: 'Update Automation',
        description: 'Root-union probe.',
        parameters: { oneOf: [{ type: 'object' }] } as never,
        executionMode: 'sequential' as const,
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: { ok: true } }),
      }],
      assembleRegistry: true,
    });

    await expect(runtime.createTools(RUNTIME_CONTEXT)).rejects.toThrow(
      'Runtime model-tool schema is invalid: automation_update',
    );
  });

  test('fails closed before an invalid extension schema can shadow a Core tool', async () => {
    const collision = {
      identity: { namespace: null, name: 'bash' },
      description: 'Invalid collision probe.',
      scope: 'anyThread',
      schemaOwner: 'extension',
      inputSchema: null,
      actionKinds: ['shell.read_search'],
    } as const satisfies ModelToolContract;
    const runtime = new ToolRuntime(runtimeService([collision]), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    await expect(runtime.createTools(RUNTIME_CONTEXT)).rejects.toThrow(
      'Duplicate canonical model tool: bash',
    );
  });

  test('keeps data import behind the public Skill and CLI boundary', async () => {
    const runtime = new ToolRuntime(runtimeService(), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });

    expect(MODEL_TOOL_CATALOG.some((contract) => canonicalModelToolKey(contract.identity) === 'data_import')).toBe(false);
    expect((await runtime.createTools(RUNTIME_CONTEXT)).some((tool) => tool.name === 'data_import')).toBe(false);
  });

});

const CONFIGURATION: EffectiveThreadConfiguration = {
  profileName: 'runtime-schema-guard',
  developerInstructions: [],
  model: 'test-model',
  reasoningEffort: 'medium',
  tools: MODEL_TOOL_CATALOG.map((contract) => canonicalModelToolKey(contract.identity)),
  skills: [],
  preloadedSkills: [],
  plugins: ['extension-probe'],
  mcpServers: [],
};

const RUNTIME_CONTEXT = {
  thread: {
    id: '00000000-0000-7000-8000-000000000001',
    parentThreadId: null,
    cwd: process.cwd(),
  },
  turn: { id: '00000000-0000-7000-8000-000000000002' },
  configuration: CONFIGURATION,
} as unknown as TurnExecutionContext;

function runtimeService(
  extensionTools: readonly ModelToolContract[] = [],
  toolPolicy?: {
    kind: 'general-purpose';
    runInBackground: boolean;
    worktree: boolean;
    allowNesting: boolean;
    requestedTools: readonly string[] | null;
  },
): ThreadService {
  return {
    collaborationToolContributions: () => [],
    extensionToolContributions: async () => extensionTools.length > 0
      ? [{ extensionId: 'extension-probe', tools: extensionTools }]
      : [],
    subagentExecution: () => toolPolicy ? {
      agentType: 'test-agent',
      initialAdmissionState: 'committed',
      toolPolicy,
    } : null,
    notifyToolStarted: async () => {},
    notifyToolCompleted: async () => {},
  } as unknown as ThreadService;
}

function runtimeSchemaTools(): AgentTool[] {
  return MODEL_TOOL_CATALOG.flatMap((contract) => contract.inputSchema === null
    ? [{
        name: canonicalModelToolKey(contract.identity),
        label: contract.identity.name,
        description: contract.description,
        parameters: { type: 'object', additionalProperties: false } as never,
        executionMode: 'sequential' as const,
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: { ok: true } }),
      }]
    : []);
}
