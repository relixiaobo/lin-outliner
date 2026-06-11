import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMemoryEntry, AgentMemorySource, AgentMemoryStreamSource, AgentPrincipal } from '../core/agentEventLog';
import type { AgentMemoryOverview, AgentMemorySchemaNode } from '../core/agentMemoryActivation';
import { samePrincipal } from '../core/agentEventLog';
import { defaultPrincipalName } from './agentMemoryBriefing';
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
entries only. It does not search the raw record (conversation history) directly and it
cannot write, update, or invalidate memory. Each entry carries "subject" — whose self-model the
fact belongs to and therefore the fact's implied subject ("self" = your own pool; otherwise the
same name the memory briefing's zone uses).

Use include_evidence only when a fact's provenance matters: it is source access — descending the
memory index from the matching entry to its recorded sources in the raw record — and the bounded
raw evidence is nested under that entry. If you omit query, the tool returns a schema overview
instead of fact hits: use it as metamemory before choosing a more specific cue.`;

const RECALL_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Optional retrieval cue matched against semantic memory facts. Omit to return the schema overview.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_RECALL_LIMIT,
      description: `Maximum entries to return. Default ${DEFAULT_RECALL_LIMIT}, max ${MAX_RECALL_LIMIT}.`,
    },
    include_evidence: {
      type: 'boolean',
      description: "When true, descend the memory index to each entry's recorded raw-record sources and expand bounded raw evidence. Default false.",
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
  /** The principal whose context the tool runs in — its own pool surfaces as subject "self". */
  reader: AgentPrincipal;
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
  overview?: AgentMemoryOverview;
}

export interface AgentRecallRuntimeEntry {
  entry: AgentMemoryEntry;
  evidence?: AgentRecallEvidence[];
  evidenceTruncated?: boolean;
}

export type AgentRecallEvidence = AgentRecallEpisodeEvidence | AgentRecallRawEvidence;

export interface AgentRecallEpisodeEvidence {
  kind: 'episode_gist';
  source: AgentMemorySource;
  episodeId: string;
  gist: string;
  createdAt: number;
  rawSources: AgentMemoryStreamSource[];
}

export interface AgentRecallRawEvidence {
  kind: 'raw_span';
  source: AgentMemorySource;
  rawSource: AgentMemoryStreamSource;
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
  overview?: AgentMemoryOverview;
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
          truncated: entries.length > 0 && result.totalEntries > entries.length,
          evidenceTruncated: entries.some((entry) => entry.evidenceTruncated),
          overview: result.overview,
        }, elapsed(started), runtime.reader);
      } catch (error) {
        return recallToolError('FAILED', error instanceof Error ? error.message : String(error), started);
      }
    },
  };
}

function recallToolResult(
  data: AgentRecallToolData,
  durationMs: number,
  reader: AgentPrincipal,
): AgentToolResult<ToolEnvelope<AgentRecallToolData>> {
  const visible = visibleRecallToolData(data, reader);
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

function visibleRecallToolData(data: AgentRecallToolData, reader: AgentPrincipal): unknown {
  return {
    entries: data.entries.map((entry) => ({
      memory_id: entry.memoryId,
      // The fact's pool, named reader-relatively (= its elided subject): without it, cross-pool
      // results are distinguishable only by accidental wording ([[agent-memory-realignment]]
      // D-3). Speaks the briefing's vocabulary — "self" / the same zone name — never a raw
      // internal principal key the model might echo into prose (gate round, #183).
      subject: recallSubject(entry.principal, reader),
      fact: entry.fact,
      status: entry.status,
      created_at: entry.createdAt,
      sources: entry.sources.map(visibleSource),
      ...(entry.evidence ? { evidence: entry.evidence.map(visibleEvidence) } : {}),
      ...(entry.evidenceTruncated ? { evidence_truncated: true } : {}),
    })),
    total_entries: data.totalEntries,
    ...(data.overview ? { overview: visibleOverview(data.overview) } : {}),
    ...(data.truncated ? { truncated: true } : {}),
    ...(data.evidenceTruncated ? { evidence_truncated: true } : {}),
  };
}

function visibleOverview(overview: AgentMemoryOverview): unknown {
  return {
    total_entries: overview.totalEntries,
    generated_at: overview.generatedAt,
    schema: overview.schema.map(visibleSchemaNode),
  };
}

function visibleSchemaNode(node: AgentMemorySchemaNode): unknown {
  return {
    schema_id: node.id,
    label: node.label,
    entry_count: node.entryCount,
    memory_ids: node.memoryIds,
    storage_strength: node.storageStrength,
    retrieval_strength: node.retrievalStrength,
  };
}

function visibleSource(source: AgentMemorySource): unknown {
  if ('episodeId' in source) {
    return { episode_id: source.episodeId };
  }
  return {
    stream: source.stream,
    stream_id: source.streamId,
    range: {
      from_seq_exclusive: source.range.fromSeqExclusive,
      through_seq: source.range.throughSeq,
      through_event_id: source.range.throughEventId,
    },
  };
}

function visibleEvidence(evidence: AgentRecallEvidence): unknown {
  if (evidence.kind === 'episode_gist') {
    return {
      kind: 'episode_gist',
      source: visibleSource(evidence.source),
      episode_id: evidence.episodeId,
      gist: evidence.gist,
      created_at: evidence.createdAt,
      raw_sources: evidence.rawSources.map(visibleSource),
    };
  }
  return {
    kind: 'raw_span',
    source: visibleSource(evidence.source),
    raw_source: visibleSource(evidence.rawSource),
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

// The reader-relative subject of a pool — the SAME vocabulary the briefing's zones use
// (`self` ↔ `<self>`, a friendly name ↔ `<principal name="…">`), so recall results ground
// against the briefing instead of leaking internal principal keys.
function recallSubject(principal: AgentPrincipal, reader: AgentPrincipal): string {
  return samePrincipal(principal, reader) ? 'self' : defaultPrincipalName(principal);
}

function recallInstructions(data: AgentRecallToolData): string | undefined {
  if (data.overview && data.entries.length === 0) {
    return 'No query was provided, so this is the schema overview of active semantic memory. Use the labels as metamemory cues; call recall again with a specific query to retrieve facts.';
  }
  if (data.entries.length === 0) {
    return "No active semantic memory entries matched this cue. Do not infer that no prior conversation exists; recall covers only the semantic store's active entries (distilled facts), not invalidated entries or the raw record.";
  }
  if (data.evidenceTruncated) {
    return 'Evidence was truncated. Treat returned evidence as supporting excerpts from the raw record, not a complete transcript.';
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
