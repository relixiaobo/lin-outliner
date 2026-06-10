import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMemoryEntry, AgentMemorySource, AgentPrincipal } from '../core/agentEventLog';
import { principalKey } from '../core/agentEventLog';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

const DEFAULT_RECALL_LIMIT = 8;
const MAX_RECALL_LIMIT = 20;
const DEFAULT_RECALL_MAX_CHARS = 4_000;
const MAX_RECALL_MAX_CHARS = 12_000;

const RECALL_TOOL_DESCRIPTION = `Cued retrieval over the Tenon agent's semantic store — the durable facts distilled from past episodes.

This is the only model-visible long-term retrieval surface. It reads active semantic memory
entries only. It does not search the raw episodic record (conversation history) directly and it
cannot write, update, or invalidate memory. Each entry carries the principal whose pool it lives
in — that principal is the fact's implied subject.

Use include_evidence only when a fact's provenance matters: it is source access — descending the
memory index from the matching entry to its recorded episodic sources — and the bounded raw
evidence is nested under that entry.`;

const RECALL_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Optional retrieval cue matched against semantic memory facts. Omit to list recent active entries.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_RECALL_LIMIT,
      description: `Maximum entries to return. Default ${DEFAULT_RECALL_LIMIT}, max ${MAX_RECALL_LIMIT}.`,
    },
    include_evidence: {
      type: 'boolean',
      description: "When true, descend the memory index to each entry's recorded episodic sources and expand bounded raw evidence. Default false.",
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_RECALL_MAX_CHARS,
      description: `Total evidence character budget. Default ${DEFAULT_RECALL_MAX_CHARS}, max ${MAX_RECALL_MAX_CHARS}.`,
    },
  },
};

export interface AgentRecallToolRuntime {
  recall(options: {
    query?: string;
    limit?: number;
    includeEvidence?: boolean;
    maxChars?: number;
  }): Promise<AgentRecallRuntimeResult>;
}

export interface AgentRecallRuntimeResult {
  entries: AgentRecallRuntimeEntry[];
  totalEntries: number;
}

export interface AgentRecallRuntimeEntry {
  entry: AgentMemoryEntry;
  evidence?: AgentRecallEvidence[];
  evidenceTruncated?: boolean;
}

export interface AgentRecallEvidence {
  source: AgentMemorySource;
  conversationId: string;
  messageId: string;
  role: string;
  createdAt: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  messageTruncated?: boolean;
}

export interface AgentRecallToolData {
  entries: AgentRecallToolEntry[];
  totalEntries: number;
  truncated: boolean;
  evidenceTruncated: boolean;
}

export interface AgentRecallToolEntry {
  memoryId: string;
  /** The pool this fact lives in — its owner/believer, and the fact's elided subject (D-3). */
  principal: AgentPrincipal;
  fact: string;
  status: AgentMemoryEntry['status'];
  createdAt: number;
  sources: AgentMemorySource[];
  evidence?: AgentRecallEvidence[];
  evidenceTruncated?: boolean;
}

export function createRecallTool(runtime: AgentRecallToolRuntime): AgentTool<any, ToolEnvelope<AgentRecallToolData>> {
  return {
    name: 'recall',
    label: 'Recall',
    description: RECALL_TOOL_DESCRIPTION,
    parameters: RECALL_TOOL_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = isRecord(rawParams) ? rawParams : {};
      try {
        const limit = clampInteger(numberParam(params.limit), DEFAULT_RECALL_LIMIT, 1, MAX_RECALL_LIMIT);
        const result = await runtime.recall({
          query: stringParam(params.query),
          limit,
          includeEvidence: params.include_evidence === true,
          maxChars: clampInteger(numberParam(params.max_chars), DEFAULT_RECALL_MAX_CHARS, 1, MAX_RECALL_MAX_CHARS),
        });
        const entries = result.entries.slice(0, limit).map(recallToolEntry);
        return recallToolResult({
          entries,
          totalEntries: result.totalEntries,
          truncated: result.totalEntries > entries.length,
          evidenceTruncated: entries.some((entry) => entry.evidenceTruncated),
        }, elapsed(started));
      } catch (error) {
        return recallToolError('FAILED', error instanceof Error ? error.message : String(error), started);
      }
    },
  };
}

function recallToolResult(
  data: AgentRecallToolData,
  durationMs: number,
): AgentToolResult<ToolEnvelope<AgentRecallToolData>> {
  const visible = visibleRecallToolData(data);
  return agentToolResult(successEnvelope<AgentRecallToolData>('recall', data, {
    instructions: recallInstructions(data),
    metrics: {
      durationMs,
      truncated: data.truncated || data.evidenceTruncated,
      outputBytes: Buffer.byteLength(JSON.stringify(visible), 'utf8'),
    },
  }), visible);
}

function recallToolError(
  code: string,
  message: string,
  started: number,
): AgentToolResult<ToolEnvelope<AgentRecallToolData>> {
  return agentToolResult(errorEnvelope<AgentRecallToolData>('recall', code, message, {
    metrics: { durationMs: elapsed(started) },
  }));
}

function visibleRecallToolData(data: AgentRecallToolData): unknown {
  return {
    entries: data.entries.map((entry) => ({
      memory_id: entry.memoryId,
      // The fact's pool (= its elided subject): without it, cross-pool results are
      // distinguishable only by accidental wording ([[agent-memory-realignment]] D-3).
      principal: principalKey(entry.principal),
      fact: entry.fact,
      status: entry.status,
      created_at: entry.createdAt,
      sources: entry.sources.map(visibleSource),
      ...(entry.evidence ? { evidence: entry.evidence.map(visibleEvidence) } : {}),
      ...(entry.evidenceTruncated ? { evidence_truncated: true } : {}),
    })),
    total_entries: data.totalEntries,
    ...(data.truncated ? { truncated: true } : {}),
    ...(data.evidenceTruncated ? { evidence_truncated: true } : {}),
  };
}

function visibleSource(source: AgentMemorySource): unknown {
  return {
    conversation_id: source.conversationId,
    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.summaryId ? { summary_id: source.summaryId } : {}),
    ...(source.messageRange ? { message_range: source.messageRange } : {}),
    ...(source.runId ? { run_id: source.runId } : {}),
    ...(source.subagentRunId ? { subagent_run_id: source.subagentRunId } : {}),
    ...(source.agentId ? { agent_id: source.agentId } : {}),
    ...(source.parentToolCallId ? { parent_tool_call_id: source.parentToolCallId } : {}),
    ...(source.eventId ? { event_id: source.eventId } : {}),
  };
}

function visibleEvidence(evidence: AgentRecallEvidence): unknown {
  return {
    source: visibleSource(evidence.source),
    conversation_id: evidence.conversationId,
    message_id: evidence.messageId,
    role: evidence.role,
    created_at: evidence.createdAt,
    text: evidence.text,
    ...(evidence.toolName ? { tool_name: evidence.toolName } : {}),
    ...(evidence.isError ? { is_error: true } : {}),
    ...(evidence.messageTruncated ? { message_truncated: true } : {}),
  };
}

function recallInstructions(data: AgentRecallToolData): string | undefined {
  if (data.entries.length === 0) {
    return "No active semantic memory entries matched this cue. Do not infer that no prior conversation exists; recall covers only the semantic store's active entries (distilled facts), not invalidated entries or the raw episodic record.";
  }
  if (data.evidenceTruncated) {
    return 'Evidence was truncated. Treat returned evidence as supporting excerpts from the episodic record, not a complete transcript.';
  }
  return undefined;
}

function recallToolEntry(item: AgentRecallRuntimeEntry): AgentRecallToolEntry {
  return {
    memoryId: item.entry.id,
    principal: item.entry.principal,
    fact: item.entry.fact,
    status: item.entry.status,
    createdAt: item.entry.createdAt,
    sources: item.entry.sources,
    evidence: item.evidence,
    evidenceTruncated: item.evidenceTruncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined ? fallback : Math.trunc(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(min, Math.min(max, candidate));
}

function elapsed(started: number): number {
  return Date.now() - started;
}
