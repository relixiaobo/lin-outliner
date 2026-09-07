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
import {
  compileToolParameters,
  validateExactToolArguments,
} from '../../src/main/agent/runtime/kernel/exactToolArguments';
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

  test('declares and compiles output-data validation for every catalog tool', () => {
    expect(MODEL_TOOL_CATALOG).toHaveLength(21);
    const failures: string[] = [];
    for (const contract of MODEL_TOOL_CATALOG) {
      const name = canonicalModelToolKey(contract.identity);
      if (contract.outputSchema === undefined) {
        failures.push(`${name}: missing output schema declaration`);
        continue;
      }
      if (contract.outputSchema === null) continue;
      try {
        compileToolParameters(contract.outputSchema as never);
      } catch (error) {
        failures.push(`${name}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('rejects undeclared model-visible output fields', () => {
    const schema = (name: string) => {
      const contract = MODEL_TOOL_CATALOG.find((candidate) => canonicalModelToolKey(candidate.identity) === name);
      if (!contract?.outputSchema) throw new Error(`Missing ${name} output schema`);
      return compileToolParameters(contract.outputSchema as never);
    };

    expect(schema('file_read').Check({
      file: {
        filePath: '/workspace/input.txt',
        content: 'private full content',
        base64: 'private bytes',
        internalPath: '/private/runtime/path',
      },
    })).toBe(false);
    expect(schema('thread_search').Check({
      results: [{ threadId: 'thread-id', title: 'Title', updatedAt: 1, snippet: 'Hit', readCursor: null, internal: true }],
      untrusted: true,
    })).toBe(false);
    expect(schema('create_goal').Check({
      goal: { objective: 'Ship it', internalContinuationState: true },
    })).toBe(false);
    expect(schema('task_status').Check({
      taskId: 'task-1',
      state: 'failed',
      progress: { phase: 'queued', message: 'Waiting for capacity', fraction: null },
      result: {
        exitCode: null,
        signal: null,
        reason: 'storage_limit',
        error: 'Storage reservation failed.',
        output: null,
        outputTruncated: false,
        detailState: 'storage_pressure',
        artifacts: [{
          id: 'artifact-1',
          label: 'Rendered clip',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          byteLength: 12,
        }],
        storagePressure: {
          scope: 'thread',
          limitBytes: 1_024,
          usedBytes: 900,
          requiredBytes: 256,
          reclaimableBytes: 100,
          protectedBytes: 800,
        },
      },
    })).toBe(true);
    expect(schema('task_status').Check({
      taskId: 'task-2',
      state: 'succeeded',
      progress: null,
      result: {
        exitCode: 0,
        signal: null,
        reason: 'exit_zero',
        error: null,
        output: null,
        outputTruncated: false,
        detailState: 'cleared',
        artifacts: [],
        storagePressure: null,
      },
    })).toBe(true);
  });

  test('offers every static model-tool schema to providers as an object-rooted schema', () => {
    const unsendable = MODEL_TOOL_CATALOG
      .filter((contract) => contract.inputSchema !== null)
      .map((contract) => `${canonicalModelToolKey(contract.identity)}: ${providerToolSchemaFailure(contract.inputSchema)}`)
      .filter((entry) => !entry.endsWith(': null'));
    expect(unsendable).toEqual([]);
  });

  test('requires a valid representation for every selected historical citation', () => {
    const contract = MODEL_TOOL_CATALOG.find((candidate) => canonicalModelToolKey(candidate.identity) === 'thread_read');
    if (!contract?.inputSchema) throw new Error('Missing thread_read contract');
    const tool = {
      name: 'thread_read',
      label: 'Thread Read',
      description: contract.description,
      parameters: contract.inputSchema as never,
      executionMode: 'sequential' as const,
      execute: async () => ({ kind: 'tenon' as const, outcome: { ok: true as const }, data: {}, content: [], details: {} }),
    } satisfies AgentTool;

    expect(() => validateExactToolArguments(tool, {
      thread_id: '01951d6e-7c25-7c31-8d62-313038616239',
      citations: [{ citation_key: 'citation:key' }],
    })).toThrow('Invalid arguments for tool "thread_read"');
    expect(() => validateExactToolArguments(tool, {
      thread_id: '01951d6e-7c25-7c31-8d62-313038616239',
      citations: [{ citation_key: 'citation:key', representation: 'overwrite' }],
    })).toThrow('Invalid arguments for tool "thread_read"');
    expect(() => validateExactToolArguments(tool, {
      thread_id: '01951d6e-7c25-7c31-8d62-313038616239',
      citations: [{ citation_key: 'citation:key', representation: 'edit' }],
    })).not.toThrow();
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
        execute: async () => ({ kind: 'tenon' as const, outcome: { ok: true as const }, data: {}, content: [], details: { ok: true } }),
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

  test('applies global disabled tools after the Thread capability ceiling', async () => {
    const runtime = new ToolRuntime(runtimeService(), {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
      disabledTools: () => ['bash'],
    });

    expect((await runtime.createTools(RUNTIME_CONTEXT)).some((tool) => tool.name === 'bash')).toBe(false);
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
): ThreadService {
  return {
    extensionToolContributions: async () => extensionTools.length > 0
      ? [{ extensionId: 'extension-probe', tools: extensionTools }]
      : [],
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
        execute: async () => ({ kind: 'tenon' as const, outcome: { ok: true as const }, data: {}, content: [], details: { ok: true } }),
      }]
    : []);
}
