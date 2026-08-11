import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  type ModelToolContract,
} from '../../src/core/agent/tools';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { OutlinerToolHost } from '../../src/main/agent/capabilities/agentNodeTools';
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

  test('fails closed when a Core capability schema cannot compile', async () => {
    const tools = runtimeSchemaTools().map((tool) => tool.name === 'bash'
      ? {
          ...tool,
          parameters: {
            type: 'object',
            patternProperties: { '[': { type: 'string' } },
          } as never,
        }
      : tool);
    const runtime = new ToolRuntime(runtimeService(), {
      capabilityTools: () => tools,
      assembleRegistry: true,
    });

    await expect(runtime.createTools(RUNTIME_CONTEXT)).rejects.toThrow(
      'Runtime model-tool schema is invalid: bash',
    );
  });

  test('reuses the data-import schema across runtime catalogs', async () => {
    const runtime = new ToolRuntime(runtimeService(), {
      outliner: OUTLINER,
      capabilityTools: () => runtimeSchemaTools().filter((tool) => tool.name !== 'data_import'),
      assembleRegistry: true,
    });
    const first = await runtime.createTools(RUNTIME_CONTEXT);
    const second = await runtime.createTools(RUNTIME_CONTEXT);

    expect(first.find((tool) => tool.name === 'data_import')?.parameters)
      .toBe(second.find((tool) => tool.name === 'data_import')?.parameters);
  });
});

const CONFIGURATION: EffectiveThreadConfiguration = {
  profileName: 'runtime-schema-guard',
  developerInstructions: [],
  model: 'test-model',
  reasoningEffort: 'medium',
  tools: MODEL_TOOL_CATALOG.map((contract) => canonicalModelToolKey(contract.identity)),
  skills: [],
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

const OUTLINER: OutlinerToolHost = {
  getProjection: () => { throw new Error('Schema guard does not read the Outliner.'); },
  handle: async () => { throw new Error('Schema guard does not mutate the Outliner.'); },
};

function runtimeService(extensionTools: readonly ModelToolContract[] = []): ThreadService {
  return {
    collaborationToolContributions: () => [],
    extensionToolContributions: async () => extensionTools.length > 0
      ? [{ extensionId: 'extension-probe', tools: extensionTools }]
      : [],
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
