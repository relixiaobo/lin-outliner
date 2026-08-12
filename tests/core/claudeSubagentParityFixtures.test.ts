import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import { stream as streamAnthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  AGENT_MESSAGE_TOOL_DESCRIPTION,
  AGENT_TOOL_DESCRIPTION,
  TASK_STOP_INPUT_SCHEMA,
  TASK_STOP_TOOL_DESCRIPTION,
  agentInputSchema,
} from '../../src/core/agent/tools';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import { agentProviderPayload } from '../../src/main/agent/runtime/PiTurnExecutor';
import {
  DEFAULT_CAPTURE_COMPACT_SHA256,
  FORK_CAPTURE_COMPACT_SHA256,
  normalizeDefaultToolCatalog,
  normalizeOutputHelpers,
  normalizeOutputScanCorpus,
  projectForkToolCatalog,
} from '../fixtures/claude-subagent-parity/normalizer';

const DEFAULT_RAW = fixture('raw/tool-catalog-default.json');
const FORK_RAW = fixture('raw/tool-catalog-fork-profile.json');
const DEFAULT_EXPECTED = fixture('expected/tool-catalog-default.json');
const FORK_EXPECTED = fixture('expected/tool-catalog-fork-profile.json');
const ANTHROPIC_WIRE_EXPECTED = fixture('expected/anthropic-wire.json');
const OUTPUT_HELPERS_RAW = fixture('raw/output-helpers.json');
const OUTPUT_HELPERS_EXPECTED = fixture('expected/output-helpers.json');
const OUTPUT_SCAN_RAW = fixture('raw/output-scan.json');
const OUTPUT_SCAN_EXPECTED = fixture('expected/output-scan.json');
const MODELS = ['claude-sonnet-test', 'claude-opus-test'] as const;

describe('Claude Code 2.1.227 Subagent parity fixtures', () => {
  test('freezes the complete captured catalogs and projects only the selected three tools', () => {
    expect(compactDigest(DEFAULT_RAW)).toBe(DEFAULT_CAPTURE_COMPACT_SHA256);
    expect(compactDigest(FORK_RAW)).toBe(FORK_CAPTURE_COMPACT_SHA256);
    expect(toolNames(DEFAULT_RAW)).toEqual(['Agent', 'ListAgents', 'Monitor', 'SendMessage', 'TaskStop']);
    expect(toolNames(FORK_RAW)).toEqual(['Agent', 'SendMessage', 'TaskStop']);

    const normalized = normalizeDefaultToolCatalog(DEFAULT_RAW);
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(DEFAULT_EXPECTED));
    expect(toolNames(normalized)).toEqual(['agent', 'agent_message', 'task_stop']);

    const altered = structuredClone(DEFAULT_RAW) as Array<Record<string, unknown>>;
    altered[3] = { ...altered[3], name: 'UnexpectedMessageTool' };
    expect(() => normalizeDefaultToolCatalog(altered)).toThrow(
      'Normalizer source mismatch at $[3].name',
    );
  });

  test('records that the unselected Fork profile removes run_in_background', () => {
    const projected = projectForkToolCatalog(FORK_RAW);
    expect(JSON.stringify(projected)).toBe(JSON.stringify(FORK_EXPECTED));
    const forkAgent = tools(projected)[0]!;
    const defaultAgent = tools(DEFAULT_RAW)[0]!;
    expect(propertyNames(forkAgent)).toEqual(['description', 'prompt', 'subagent_type', 'model', 'isolation']);
    expect(propertyNames(defaultAgent)).toEqual([
      'description',
      'prompt',
      'subagent_type',
      'model',
      'run_in_background',
      'isolation',
    ]);
    expect(JSON.stringify(forkAgent)).not.toContain('run_in_background');
  });

  test('matches production contracts to the independently normalized expected bytes', () => {
    const productionCatalog = [
      {
        name: 'agent',
        description: AGENT_TOOL_DESCRIPTION,
        input_schema: agentInputSchema(MODELS),
      },
      {
        name: 'agent_message',
        description: AGENT_MESSAGE_TOOL_DESCRIPTION,
        input_schema: AGENT_MESSAGE_INPUT_SCHEMA,
      },
      {
        name: 'task_stop',
        description: TASK_STOP_TOOL_DESCRIPTION,
        input_schema: TASK_STOP_INPUT_SCHEMA,
      },
    ];
    expect(JSON.stringify(productionCatalog)).toBe(JSON.stringify(DEFAULT_EXPECTED));
    expect(Object.keys(productionCatalog[0]!.input_schema as object)).toEqual([
      '$schema',
      'type',
      'properties',
      'required',
      'additionalProperties',
    ]);
    expect(Object.keys((productionCatalog[0]!.input_schema as Record<string, unknown>).properties as object)).toEqual([
      'description',
      'prompt',
      'subagent_type',
      'model',
      'run_in_background',
      'isolation',
    ]);
    expect(Object.keys((productionCatalog[1]!.input_schema as Record<string, unknown>).properties as object)).toEqual([
      'to',
      'summary',
      'message',
    ]);
    expect((productionCatalog[2]!.input_schema as Record<string, unknown>).required).toBeUndefined();
  });

  test('matches the real Anthropic conversion and payload hook to frozen wire bytes', async () => {
    const productionTools = productionAgentTools();
    const payloads: unknown[] = [];
    const client = {
      messages: {
        create: (payload: unknown) => ({
          asResponse: async () => {
            payloads.push(payload);
            return anthropicTextResponse('done');
          },
        }),
      },
    };

    const result = await streamAnthropicMessages(ANTHROPIC_MODEL, {
      systemPrompt: 'Test system prompt',
      messages: [{ role: 'user', content: 'Test request', timestamp: 1 }],
      tools: productionTools,
    }, {
      client: client as never,
      onPayload: (payload, model) => agentProviderPayload(payload, model, null, productionTools),
    }).result();

    expect(result.stopReason).toBe('stop');
    const productionWire = payloadTools(payloads[0]);
    expect(JSON.stringify(productionWire)).toBe(JSON.stringify(ANTHROPIC_WIRE_EXPECTED));
    expect(Object.keys(productionWire[0]!)).toEqual([
      'name',
      'description',
      'input_schema',
      'eager_input_streaming',
    ]);
    expect(Object.keys(productionWire[0]!.input_schema as object)).toEqual([
      '$schema',
      'type',
      'properties',
      'required',
      'additionalProperties',
    ]);
    expect(Object.keys(productionWire[2]!.input_schema as object)).toEqual([
      '$schema',
      'type',
      'properties',
      'additionalProperties',
    ]);
  });

  test('normalizes captured output helper texts through declared slots only', () => {
    expect(JSON.stringify(normalizeOutputHelpers(OUTPUT_HELPERS_RAW)))
      .toBe(JSON.stringify(OUTPUT_HELPERS_EXPECTED));
  });

  test('freezes the output scan corpus independently of production', () => {
    expect(JSON.stringify(normalizeOutputScanCorpus(OUTPUT_SCAN_RAW)))
      .toBe(JSON.stringify(OUTPUT_SCAN_EXPECTED));
    const rows = OUTPUT_SCAN_EXPECTED as Array<{
      readonly name: string;
      readonly input: string;
      readonly output: string;
    }>;
    const ordinary = rows.find((row) => row.name === 'ordinary-output');
    expect(ordinary?.input).toBe(ordinary?.output);
  });
});

function fixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(
    new URL(`../fixtures/claude-subagent-parity/${relativePath}`, import.meta.url),
    'utf8',
  ));
}

function productionAgentTools(): AgentTool[] {
  return [
    agentTool('agent', AGENT_TOOL_DESCRIPTION, agentInputSchema(MODELS)),
    agentTool('agent_message', AGENT_MESSAGE_TOOL_DESCRIPTION, AGENT_MESSAGE_INPUT_SCHEMA),
    agentTool('task_stop', TASK_STOP_TOOL_DESCRIPTION, TASK_STOP_INPUT_SCHEMA),
  ];
}

function agentTool(
  name: string,
  description: string,
  parameters: Readonly<Record<string, unknown>>,
): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: parameters as AgentTool['parameters'],
    executionMode: 'sequential',
    execute: async () => ({ content: [{ type: 'text', text: 'unused' }], details: {} }),
  };
}

function payloadTools(payload: unknown): Array<Record<string, unknown>> {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    throw new Error('Anthropic parity payload must contain tools');
  }
  return tools(payload.tools);
}

function anthropicTextResponse(text: string): Response {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        content: [],
        model: ANTHROPIC_MODEL.id,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  return new Response(events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function compactDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((tool) => !isRecord(tool))) {
    throw new Error('Parity fixture must be an array of tool objects');
  }
  return value as Array<Record<string, unknown>>;
}

function toolNames(value: unknown): unknown[] {
  return tools(value).map((tool) => tool.name);
}

function propertyNames(tool: Record<string, unknown>): string[] {
  const schema = tool.input_schema;
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error('Parity fixture tool must have object properties');
  }
  return Object.keys(schema.properties);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ANTHROPIC_MODEL = {
  id: 'claude-sonnet-test',
  name: 'Claude Sonnet Test',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<'anthropic-messages'>;
