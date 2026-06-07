import { isHiddenAgentContextBlock } from '../core/agentAttachments';
import {
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentMemoryEntry,
  type AgentMemorySource,
  type AgentPersistedContent,
  getAgentEventRuntimeTranscriptPath,
} from '../core/agentEventLog';
import type { UserMessage } from '../core/agentTypes';
import { MAX_AGENT_MEMORY_FACT_CHARS } from './agentEventStore';

const DREAM_TRANSCRIPT_CHAR_BUDGET = 60_000;
const DREAM_MESSAGE_CONTENT_CHAR_BUDGET = 12_000;
const DREAM_EXISTING_MEMORY_LIMIT = 50;
const DREAM_MAX_ACTIONS = 5;

type DreamMemoryActionType = 'add' | 'update' | 'forget';

export interface DreamMemoryExtractionSpan {
  conversationId: string;
  runId: string;
  source: AgentMemorySource;
  transcript: string;
}

export type DreamMemoryAction =
  | { type: 'add'; fact: string }
  | { type: 'update'; memoryId: string; fact: string }
  | { type: 'forget'; memoryId: string; reason?: string };

export interface DreamMemoryExtractionRequestInput {
  span: DreamMemoryExtractionSpan;
  existingMemories: readonly AgentMemoryEntry[];
  originWorkspace?: string;
}

export function buildDreamMemoryExtractionSpan(
  conversationId: string,
  state: AgentEventReplayState,
  runId: string,
): DreamMemoryExtractionSpan | null {
  const run = state.runs[runId];
  if (run?.status !== 'completed') return null;
  const activePath = getAgentEventRuntimeTranscriptPath(state);
  const lastRunMessageIndex = findLastRunMessageIndex(activePath, runId);
  if (lastRunMessageIndex < 0) return null;
  const firstRunMessageIndex = findFirstRunMessageIndex(activePath, runId);
  const fromIndex = findCurrentTurnStartIndex(activePath, firstRunMessageIndex);
  const slice = activePath.slice(fromIndex, lastRunMessageIndex + 1);
  const from = slice[0];
  const through = slice.at(-1);
  if (!from || !through) return null;
  const transcript = renderDreamTranscript(slice);
  if (!transcript.trim()) return null;
  const source: AgentMemorySource = {
    conversationId,
    messageRange: [from.id, through.id],
    runId,
  };
  if (state.latestEventId) source.eventId = state.latestEventId;
  return {
    conversationId,
    runId,
    source,
    transcript,
  };
}

export function buildDreamMemoryExtractionRequest(input: DreamMemoryExtractionRequestInput): UserMessage {
  const existing = input.existingMemories.slice(0, DREAM_EXISTING_MEMORY_LIMIT)
    .map((entry) => `- ${entry.id}: ${entry.fact}`)
    .join('\n') || '(none)';
  const workspace = input.originWorkspace ?? '(none)';
  const prompt = `You are Tenon's private Dream memory extractor.

You do not have tools. You cannot write files. Return JSON only.

Analyze the raw evidence from the most recent completed foreground run and propose at most ${DREAM_MAX_ACTIONS} durable memory changes.

Rules:
- Save only stable facts, user preferences, durable decisions, project conventions, or relationship context that should help future turns.
- Do not save transient task steps, temporary status, command output, secrets, credentials, raw logs, or facts already represented as durable outline content.
- Do not infer beyond the raw evidence. If the evidence is ambiguous, emit no action.
- Prefer updating or forgetting an existing memory when the new evidence corrects or supersedes it.
- Never mention that memory was saved. The foreground assistant did not call a memory write tool.
- Ground every action in the raw evidence below, not in summaries.

Output schema:
{
  "actions": [
    { "type": "add", "fact": "..." },
    { "type": "update", "memory_id": "memory-id", "fact": "..." },
    { "type": "forget", "memory_id": "memory-id", "reason": "..." }
  ]
}

Current origin workspace: ${workspace}

Existing active memory:
${existing}

Raw evidence:
<conversation_run>
${input.span.transcript}
</conversation_run>`;

  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'text', text: prompt }],
  };
}

export function parseDreamMemoryActions(responseText: string): DreamMemoryAction[] {
  const parsed = parseJsonObject(responseText);
  if (!parsed || !Array.isArray(parsed.actions)) return [];
  const actions: DreamMemoryAction[] = [];
  for (const raw of parsed.actions) {
    if (actions.length >= DREAM_MAX_ACTIONS) break;
    const action = normalizeDreamMemoryAction(raw);
    if (action) actions.push(action);
  }
  return actions;
}

export function mergeMemorySources(
  existing: readonly AgentMemorySource[],
  next: AgentMemorySource,
): AgentMemorySource[] {
  const merged: AgentMemorySource[] = [];
  const seen = new Set<string>();
  for (const source of [...existing, next]) {
    const key = JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

export function memoryFactKey(fact: string): string {
  return fact.trim().replace(/\s+/g, ' ').toLowerCase();
}

function renderDreamTranscript(messages: readonly AgentEventMessageRecord[]): string {
  const rendered = messages
    .map((message, index) => renderDreamMessage(message, index + 1))
    .filter(Boolean)
    .join('\n\n');
  if (rendered.length <= DREAM_TRANSCRIPT_CHAR_BUDGET) return rendered;
  return `[older raw evidence truncated]\n${rendered.slice(rendered.length - DREAM_TRANSCRIPT_CHAR_BUDGET)}`;
}

function renderDreamMessage(message: AgentEventMessageRecord, index: number): string {
  const header = `### ${index}. ${message.role} message ${message.id}${message.runId ? ` (run ${message.runId})` : ''}`;
  const content = renderPersistedContent(message.content);
  const details: string[] = [];
  if (message.role === 'toolResult' && message.toolName) details.push(`tool: ${message.toolName}`);
  if (message.outputSummary) details.push(`summary: ${message.outputSummary}`);
  if (message.errorMessage) details.push(`error: ${message.errorMessage}`);
  const body = [...details, content].filter(Boolean).join('\n');
  return body ? `${header}\n${body}` : '';
}

function renderPersistedContent(content: readonly AgentPersistedContent[]): string {
  return content
    .flatMap((part) => {
      if (part.type === 'text') {
        if (isHiddenAgentContextBlock(part.text)) return [];
        return [part.text.trim()];
      }
      if (part.type === 'thinking') return ['[thinking omitted]'];
      if (part.type === 'toolCall') return [`tool call: ${part.name} ${JSON.stringify(part.arguments)}`];
      if (part.type === 'image') return [part.alt || part.imageRef.summary || `[image:${part.imageRef.id}]`];
      return [part.label || part.payload.summary || `[payload:${part.payload.id}]`];
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, DREAM_MESSAGE_CONTENT_CHAR_BUDGET);
}

function findFirstRunMessageIndex(messages: readonly AgentEventMessageRecord[], runId: string): number {
  return messages.findIndex((message) => message.runId === runId);
}

function findLastRunMessageIndex(messages: readonly AgentEventMessageRecord[], runId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.runId === runId) return index;
  }
  return -1;
}

function findCurrentTurnStartIndex(messages: readonly AgentEventMessageRecord[], firstRunMessageIndex: number): number {
  const previous = messages[firstRunMessageIndex - 1];
  if (previous?.role === 'user') return firstRunMessageIndex - 1;
  return firstRunMessageIndex;
}

function normalizeDreamMemoryAction(value: unknown): DreamMemoryAction | null {
  if (!isRecord(value)) return null;
  const type = normalizeActionType(value.type);
  if (!type) return null;
  if (type === 'add') {
    const fact = normalizeFact(value.fact);
    return fact ? { type, fact } : null;
  }
  const memoryId = normalizeString(value.memory_id) ?? normalizeString(value.memoryId);
  if (!memoryId) return null;
  if (type === 'update') {
    const fact = normalizeFact(value.fact);
    return fact ? { type, memoryId, fact } : null;
  }
  return {
    type,
    memoryId,
    reason: normalizeString(value.reason) ?? undefined,
  };
}

function normalizeActionType(value: unknown): DreamMemoryActionType | null {
  return value === 'add' || value === 'update' || value === 'forget' ? value : null;
}

function normalizeFact(value: unknown): string | null {
  const text = normalizeString(value);
  if (!text) return null;
  if (text.length <= MAX_AGENT_MEMORY_FACT_CHARS) return text;
  return `${text.slice(0, MAX_AGENT_MEMORY_FACT_CHARS - 3).trimEnd()}...`;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || null : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(text.trim());
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
