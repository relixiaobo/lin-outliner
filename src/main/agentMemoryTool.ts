import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMemoryEntry } from '../core/agentEventLog';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

const MEMORY_TOOL_DESCRIPTION = `Read and update durable facts the Tenon agent should remember across conversations.

Use this for stable user preferences, durable project facts, or decisions that will matter in future conversations.
Do not store secrets, one-off tasks, raw conversation summaries, or facts that are only relevant to the current turn.

Actions:
- list: retrieve remembered facts, optionally filtered by query.
- remember: add one concise durable fact.
- update: replace the text of an existing memory entry.
- forget: invalidate an existing memory entry.`;

const MEMORY_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'remember', 'update', 'forget'],
      description: 'Memory operation to run.',
    },
    fact: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'A concise durable fact. Required for remember and update.',
    },
    memory_id: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Memory id. Required for update and forget.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Optional keyword query for list.',
    },
    include_invalidated: {
      type: 'boolean',
      description: 'List invalidated entries too. Default false.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum entries to return for list. Default 20, max 50.',
    },
  },
};

export interface AgentMemoryToolRuntime {
  list(options: { query?: string; includeInvalidated?: boolean; limit?: number }): Promise<{
    entries: AgentMemoryEntry[];
    totalEntries: number;
  }>;
  remember(fact: string): Promise<AgentMemoryEntry>;
  update(memoryId: string, fact: string): Promise<AgentMemoryEntry | null>;
  forget(memoryId: string): Promise<AgentMemoryEntry | null>;
}

export type AgentMemoryToolData =
  | {
      action: 'list';
      entries: AgentMemoryToolEntry[];
      totalEntries: number;
      truncated: boolean;
    }
  | {
      action: 'remember' | 'update';
      entry: AgentMemoryToolEntry;
    }
  | {
      action: 'forget';
      memoryId: string;
      invalidated: boolean;
      entry?: AgentMemoryToolEntry;
    };

export interface AgentMemoryToolEntry {
  memoryId: string;
  fact: string;
  status: AgentMemoryEntry['status'];
  createdAt: number;
}

export function createMemoryTool(runtime: AgentMemoryToolRuntime): AgentTool<any, ToolEnvelope<AgentMemoryToolData>> {
  return {
    name: 'memory',
    label: 'Memory',
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: MEMORY_TOOL_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = isRecord(rawParams) ? rawParams : {};
      const action = typeof params.action === 'string' ? params.action : '';

      try {
        if (action === 'list') {
          const limit = clampLimit(numberParam(params.limit), 20, 50);
          const result = await runtime.list({
            query: stringParam(params.query),
            includeInvalidated: params.include_invalidated === true,
            limit,
          });
          const visibleEntries = result.entries.slice(0, limit).map(memoryToolEntry);
          return memoryToolResult({
            action: 'list',
            entries: visibleEntries,
            totalEntries: result.totalEntries,
            truncated: result.totalEntries > visibleEntries.length,
          }, elapsed(started));
        }

        if (action === 'remember') {
          const fact = requiredString(params.fact);
          if (!fact) return memoryToolError('MISSING_FACT', 'Pass fact for remember.', started);
          const entry = await runtime.remember(fact);
          return memoryToolResult({ action: 'remember', entry: memoryToolEntry(entry) }, elapsed(started));
        }

        if (action === 'update') {
          const memoryId = requiredString(params.memory_id);
          const fact = requiredString(params.fact);
          if (!memoryId) return memoryToolError('MISSING_MEMORY_ID', 'Pass memory_id for update.', started);
          if (!fact) return memoryToolError('MISSING_FACT', 'Pass fact for update.', started);
          const entry = await runtime.update(memoryId, fact);
          if (!entry) return memoryToolError('NOT_FOUND', `No memory entry exists for ${memoryId}.`, started);
          return memoryToolResult({ action: 'update', entry: memoryToolEntry(entry) }, elapsed(started));
        }

        if (action === 'forget') {
          const memoryId = requiredString(params.memory_id);
          if (!memoryId) return memoryToolError('MISSING_MEMORY_ID', 'Pass memory_id for forget.', started);
          const entry = await runtime.forget(memoryId);
          if (!entry) return memoryToolError('NOT_FOUND', `No memory entry exists for ${memoryId}.`, started);
          return memoryToolResult({
            action: 'forget',
            memoryId,
            invalidated: entry.status === 'invalidated',
            entry: memoryToolEntry(entry),
          }, elapsed(started));
        }

        return memoryToolError('INVALID_ACTION', 'Pass action as list, remember, update, or forget.', started);
      } catch (error) {
        return memoryToolError('FAILED', error instanceof Error ? error.message : String(error), started);
      }
    },
  };
}

function memoryToolResult(
  data: AgentMemoryToolData,
  durationMs: number,
): AgentToolResult<ToolEnvelope<AgentMemoryToolData>> {
  const envelope = successEnvelope<AgentMemoryToolData>('memory', data, {
    instructions: memoryInstructions(data),
    metrics: {
      durationMs,
      truncated: data.action === 'list' ? data.truncated : undefined,
      outputBytes: Buffer.byteLength(JSON.stringify(visibleMemoryToolData(data)), 'utf8'),
    },
  });
  return agentToolResult(envelope, visibleMemoryToolData(data));
}

function memoryToolError(
  code: string,
  message: string,
  started: number,
): AgentToolResult<ToolEnvelope<AgentMemoryToolData>> {
  return agentToolResult(errorEnvelope<AgentMemoryToolData>('memory', code, message, {
    metrics: { durationMs: elapsed(started) },
  }));
}

function visibleMemoryToolData(data: AgentMemoryToolData): unknown {
  if (data.action === 'list') {
    return {
      entries: data.entries.map(visibleMemoryEntry),
      total_entries: data.totalEntries,
      ...(data.truncated ? { truncated: true } : {}),
    };
  }
  if (data.action === 'forget') {
    return {
      memory_id: data.memoryId,
      invalidated: data.invalidated,
    };
  }
  return { entry: visibleMemoryEntry(data.entry) };
}

function visibleMemoryEntry(entry: AgentMemoryToolEntry): unknown {
  return {
    memory_id: entry.memoryId,
    fact: entry.fact,
    status: entry.status,
    created_at: entry.createdAt,
  };
}

function memoryInstructions(data: AgentMemoryToolData): string | undefined {
  if (data.action === 'list' && data.entries.length === 0) {
    return 'No durable memories matched. Do not infer that no past conversation exists; this tool only covers explicitly remembered facts.';
  }
  if (data.action === 'remember') return 'The fact is now available in future conversation memory reminders.';
  if (data.action === 'forget') return 'Treat the invalidated memory as no longer true unless the user states it again.';
  return undefined;
}

function memoryToolEntry(entry: AgentMemoryEntry): AgentMemoryToolEntry {
  return {
    memoryId: entry.id,
    fact: entry.fact,
    status: entry.status,
    createdAt: entry.createdAt,
  };
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function elapsed(started: number): number {
  return Date.now() - started;
}
