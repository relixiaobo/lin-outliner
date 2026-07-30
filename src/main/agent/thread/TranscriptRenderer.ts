/**
 * TranscriptRenderer — the single faithful Turn -> text projection.
 *
 * AUTHORITY. This module is the ONLY faithful renderer of canonical Turns into
 * readable text. Every later faithful-text need — the terminal transcript
 * artifact, the `agent:dump` operator CLI, any forensics export — routes here
 * instead of growing a second copy. A parallel renderer is exactly what makes
 * two disagreeing "truths" about one Thread possible.
 *
 * EXEMPTION (do not unify). `deterministicSummary` in
 * `context/ContextCompaction.ts` is LOSSY BY CONTRACT: one line per Item,
 * globally clamped to a context budget, written for a provider audience that
 * must forget detail. This renderer has the opposite contract — keep whatever
 * the store kept, for a reader that pulls detail on demand. Merging them would
 * force one of the two contracts to break, so they stay separate on purpose.
 *
 * PURITY. Turns plus a payload reader are injected; this module imports no
 * store and performs no I/O of its own. Bounds reuse the persistence caps
 * (`MAX_PERSISTED_*`), so the projection is bounded exactly where the canonical
 * record is bounded rather than at a second, invented limit.
 */
import type {
  DynamicToolCallThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadUserContent,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
} from '../../../core/agent/protocol';
import { historyToolArguments, historyToolIdentity, toolItemVisibleOutputText } from '../context/ContextProjector';
import {
  MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
} from '../runtime/PiTurnExecutor';

/** Injected read surface. Every reference resolves through the caller's store. */
export interface TranscriptPayloadReader {
  readContext(ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  readOutput(ref: ThreadItemOutputReference): Promise<string | null>;
  /** Optional: `full` detail renders per-provider-call usage when available. */
  readDiagnostics?(ref: TurnDiagnosticsPayloadReference): Promise<TurnDiagnosticsPayload | null>;
}

/**
 * `brief` is the delegated-result audience (a parent model verifying a claim).
 * `full` adds the identities a human or debugging agent needs to cross-reference
 * the canonical store: Item ids, payload digests, per-provider-call usage, and
 * raw reasoning content.
 */
export type TranscriptDetail = 'brief' | 'full';

/** Identity of the rendered Thread. Every field is optional metadata, never structure. */
export interface TranscriptSubject {
  readonly threadId?: string;
  readonly taskPath?: string | null;
  readonly role?: string | null;
  readonly nickname?: string | null;
  readonly model?: string | null;
  readonly status?: string | null;
  readonly cwd?: string | null;
}

export interface RenderTranscriptOptions {
  readonly detail?: TranscriptDetail;
  readonly subject?: TranscriptSubject;
}

/** Free text is persisted unbounded; cap it at the tool-output bound for parity. */
const MAX_TRANSCRIPT_TEXT_CHARS = MAX_PERSISTED_TOOL_OUTPUT_CHARS;

export async function renderTranscript(
  turns: readonly Turn[],
  reader: TranscriptPayloadReader,
  options: RenderTranscriptOptions = {},
): Promise<string> {
  const detail = options.detail ?? 'brief';
  const lines: string[] = [
    '# Agent Thread transcript',
    '',
    'Faithful projection of the canonical Turns of one Thread, bounded per field.',
    'Each entry is a heading, then metadata lines, then verbatim content:',
    'a heading that appears inside content is content, not structure.',
    '',
    ...subjectLines(options.subject, turns.length, detail),
  ];

  for (const [index, turn] of turns.entries()) {
    lines.push('', ...await turnLines(turn, index + 1, turns.length, reader, detail));
  }

  if (turns.length === 0) lines.push('', 'No Turns are persisted for this Thread yet.');
  return `${lines.join('\n').trimEnd()}\n`;
}

function subjectLines(
  subject: TranscriptSubject | undefined,
  turnCount: number,
  detail: TranscriptDetail,
): string[] {
  const entries: Array<[string, string | null | undefined]> = [
    ['threadId', subject?.threadId],
    ['taskPath', subject?.taskPath],
    ['role', subject?.role],
    ['nickname', subject?.nickname],
    ['model', subject?.model],
    ['status', subject?.status],
    ['cwd', subject?.cwd],
  ];
  return [
    ...entries.flatMap(([key, value]) => (value ? [`${key}: ${value}`] : [])),
    `turns: ${turnCount}`,
    `detail: ${detail}`,
  ];
}

async function turnLines(
  turn: Turn,
  ordinal: number,
  total: number,
  reader: TranscriptPayloadReader,
  detail: TranscriptDetail,
): Promise<string[]> {
  const lines = [
    `## Turn ${ordinal}/${total} — ${turn.status}`,
    `trigger: ${triggerLabel(turn)}`,
    `duration: ${turn.durationMs === null ? 'unknown' : `${turn.durationMs}ms`}`,
    `model: ${turn.execution.modelProvider}/${turn.execution.model} (${turn.execution.reasoningEffort})`,
    `tokens: ${usageLabel(turn)}`,
  ];
  if (detail === 'full') lines.push(`turnId: ${turn.id}`, `itemsView: ${turn.itemsView}`);
  if (turn.error) lines.push(`error: ${errorLabel(turn)}`);
  if (turn.itemsView !== 'full') {
    lines.push(`[Items were not loaded at projection time: itemsView=${turn.itemsView}]`);
  }
  if (detail === 'full') lines.push(...await providerCallLines(turn, reader));

  for (const item of turn.items) lines.push('', ...await itemLines(item, reader, detail));
  return lines;
}

function triggerLabel(turn: Turn): string {
  const trigger = turn.provenance.trigger;
  switch (trigger.kind) {
    case 'user': return 'user';
    case 'subagent': return `subagent (parent ${trigger.parentThreadId})`;
    case 'feature': return trigger.ref ? `feature ${trigger.feature} (${trigger.ref})` : `feature ${trigger.feature}`;
  }
}

function usageLabel(turn: Turn): string {
  const usage = turn.execution.usage;
  return `total=${usage.totalTokens} in=${usage.input} out=${usage.output}`
    + ` cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`;
}

function errorLabel(turn: Turn): string {
  const error = turn.error;
  if (!error) return '';
  const code = error.code ? ` [${error.code}]` : '';
  const detail = error.detail ? ` — ${error.detail}` : '';
  return bounded(`${error.message}${code}${detail}`, MAX_TRANSCRIPT_TEXT_CHARS);
}

async function providerCallLines(turn: Turn, reader: TranscriptPayloadReader): Promise<string[]> {
  const ref = turn.execution.diagnosticsRef;
  if (!ref || !reader.readDiagnostics) return [];
  const diagnostics = await reader.readDiagnostics(ref).catch(() => null);
  if (!diagnostics) return [];
  return diagnostics.providerCalls.map((call) => {
    const usage = call.response?.usage;
    const stop = call.response?.stopReason ?? 'noResponse';
    const tokens = usage
      ? `total=${usage.totalTokens} in=${usage.input} out=${usage.output}`
        + ` cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`
      : 'usage unavailable';
    return `providerCall ${call.index}: ${stop} · ${tokens}`;
  });
}

async function itemLines(
  item: ThreadItem,
  reader: TranscriptPayloadReader,
  detail: TranscriptDetail,
): Promise<string[]> {
  const identity = detail === 'full' ? [`itemId: ${item.id}`] : [];
  switch (item.type) {
    case 'userMessage':
      return [
        '### User',
        ...identity,
        bounded(userContentText(item.content), MAX_TRANSCRIPT_TEXT_CHARS),
      ];
    case 'agentMessage':
      return [
        `### Assistant${item.phase ? ` (${item.phase})` : ''}`,
        ...identity,
        bounded(item.text, MAX_TRANSCRIPT_TEXT_CHARS),
      ];
    case 'reasoning': {
      const body = item.summary.length > 0 ? item.summary : ['(no reasoning summary was emitted)'];
      return [
        '### Reasoning',
        ...identity,
        bounded(body.join('\n'), MAX_TRANSCRIPT_TEXT_CHARS),
        ...(detail === 'full' && item.content.length > 0
          ? ['', 'raw reasoning:', bounded(item.content.join('\n'), MAX_TRANSCRIPT_TEXT_CHARS)]
          : []),
      ];
    }
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch': {
      const toolIdentity = historyToolIdentity(item);
      const name = toolIdentity.namespace ? `${toolIdentity.namespace}.${toolIdentity.name}` : toolIdentity.name;
      const stored = item.outputRef
        ? await reader.readOutput(item.outputRef).catch(() => null) ?? item.outputRef.summary
        : null;
      // Images never live in the text payload, so their identity lines are always appended.
      const images = item.type === 'dynamicToolCall' ? imageOutputLines(item) : [];
      const body = stored
        ?? (item.type === 'dynamicToolCall' ? dynamicTextOutput(item) : null)
        ?? toolItemVisibleOutputText(item);
      return [
        `### Tool ${name} — ${item.status}`,
        ...identity,
        ...(detail === 'full' && item.outputRef
          ? [`outputRef: ${digest(item.outputRef.id)} (${item.outputRef.byteLength} bytes)`]
          : []),
        `args: ${bounded(jsonLine(historyToolArguments(item)), MAX_PERSISTED_TOOL_ARGUMENT_CHARS)}`,
        'output:',
        bounded(body, MAX_PERSISTED_TOOL_OUTPUT_CHARS),
        ...images,
      ];
    }
    case 'subAgentActivity':
      return [`- [subagent:${item.kind}] ${item.agentPath} (${item.agentThreadId})`];
    case 'imageView':
      return [`- [image] ${item.path}`];
    case 'contextEvidence':
      return [
        `- [evidence:${item.kind}] ${bounded(item.summary, MAX_TRANSCRIPT_TEXT_CHARS)}`
        + (detail === 'full' ? ` ref=${digest(item.payloadRef.id)} (${item.payloadRef.byteLength} bytes)` : ''),
      ];
    case 'contextReset':
      return [`- [context-reset] cleared through ${cursorLabel(item.clearedThrough)}`];
    case 'contextCompaction':
      return [
        `- [context-compaction:${item.trigger}] covered ${cursorLabel(item.coveredFrom)}`
        + ` -> ${cursorLabel(item.coveredThrough)}`
        + (item.preservedFrom ? `, preserved from ${cursorLabel(item.preservedFrom)}` : '')
        + (detail === 'full' ? ` summaryRef=${digest(item.summaryRef.id)}` : ''),
      ];
  }
}

function userContentText(content: readonly ThreadUserContent[]): string {
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'attachment') {
      return `[Attachment: ${part.name} (${part.mimeType}, ${part.sizeBytes} bytes)]`;
    }
    return part.note
      ? `[Outliner Node: ${part.nodeId} — ${part.note}]`
      : `[Outliner Node: ${part.nodeId}]`;
  }).join('\n');
}

/**
 * Text and JSON parts of a dynamic tool result. Reached only when no output
 * payload was persisted (an in-flight Item, or a result with no text at all).
 */
function dynamicTextOutput(item: DynamicToolCallThreadItem): string | null {
  const parts = (item.contentItems ?? []).flatMap((part) => {
    if (part.type === 'text') return [part.text];
    if (part.type === 'json') return [jsonLine(part.value)];
    return [];
  });
  return parts.length > 0 ? parts.join('\n') : null;
}

function imageOutputLines(item: DynamicToolCallThreadItem): string[] {
  return (item.contentItems ?? []).flatMap((part) => {
    if (part.type !== 'image') return [];
    const ref = 'promptImage' in part ? part.promptImage : part.source.ref;
    const source = part.source.kind === 'localFile' ? part.source.path : part.source.ref.fileName;
    const alt = part.alt?.trim().replace(/\s+/g, ' ');
    const label = alt && alt !== source ? `${alt} (${source})` : alt || source;
    return [`[Image output: ${label}, ${ref.mimeType}, ${ref.byteLength} bytes]`];
  });
}

function cursorLabel(cursor: { readonly turnId: string; readonly itemId: string }): string {
  return `${cursor.turnId}/${cursor.itemId}`;
}

function digest(id: string): string {
  return `sha256:${id.slice(0, 12)}`;
}

function jsonLine(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

/**
 * Head-retaining truncation with an explicit byte count of what was dropped, so
 * a reader can tell "the child said nothing more" from "the record was cut".
 */
function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const kept = value.slice(0, maxChars);
  return `${kept}\n[truncated ${Buffer.byteLength(value) - Buffer.byteLength(kept)} bytes]`;
}
