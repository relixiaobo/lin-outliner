/**
 * TranscriptRenderer — the single faithful Turn -> text projection.
 *
 * AUTHORITY. This module is the ONLY faithful renderer of canonical Turns into
 * readable text. Every later faithful-text need — the transcript artifact, the
 * `agent:dump` operator CLI, any forensics export — routes here instead of
 * growing a second copy. A parallel renderer is exactly what makes two
 * disagreeing "truths" about one Thread possible.
 *
 * EXEMPTION (do not unify). `deterministicSummary` in
 * `context/ContextCompaction.ts` is LOSSY BY CONTRACT: one line per Item,
 * globally clamped to a context budget, written for a provider audience that
 * must forget detail. This renderer has the opposite contract — keep whatever
 * the store kept, for a reader that pulls detail on demand. Merging them would
 * force one of the two contracts to break, so they stay separate on purpose.
 *
 * ONE TURN IS THE UNIT. `renderTurn` renders exactly one Turn and reads only
 * that Turn's payloads; `renderTranscript` composes it. The artifact appends one
 * completed Turn at a time and never re-renders history, so the unit of
 * rendering has to be the unit of appending.
 *
 * PURITY. Turns plus a payload reader are injected; this module imports no
 * store and performs no I/O of its own. Bounds reuse the persistence caps
 * (`MAX_PERSISTED_*`) for already-bounded fields. Canonical Assistant text is
 * written verbatim so an incomplete delegated handoff can resolve the complete
 * answer from the transcript instead of capturing a second lossy projection.
 */
import type {
  DynamicToolCallThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadInternalTextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadUserContent,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
} from '../../../core/agent/protocol';
import {
  projectLargeTextArgumentsForDisplay,
  type InternalTextArgumentProjection,
} from '../runtime/largeTextArguments';
import {
  dynamicToolImageIdentity,
  toolItemVisibleOutputText,
} from '../context/ContextProjector';
import {
  modelCallArgumentSource,
  modelCallDisplayName,
} from '../../../core/agent/modelCallHistory';
import {
  MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
} from '../runtime/PiTurnExecutor';

/**
 * Injected read surface. It carries only what rendering actually calls: context
 * payloads render as one-line markers built from Item fields, so no
 * `readContext` member belongs here.
 */
export interface TranscriptPayloadReader {
  readContext(ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  readInternalTextProjection?(
    ref: ThreadInternalTextPayloadReference,
    maxPrefixChars: number,
  ): Promise<InternalTextArgumentProjection | null>;
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

/**
 * Identity of the rendered Thread. Every field is optional metadata, never
 * structure: a Thread kind that has nothing to say under a key simply omits it,
 * so adding a key here cannot change what an existing kind renders.
 */
export interface TranscriptSubject {
  readonly threadId?: string;
  readonly source?: string | null;
  readonly name?: string | null;
  readonly taskPath?: string | null;
  readonly parentThreadId?: string | null;
  readonly role?: string | null;
  readonly nickname?: string | null;
  readonly cwd?: string | null;
}

export interface RenderTurnOptions {
  readonly detail?: TranscriptDetail;
  /** 1-based position of this Turn among the Thread's completed Turns. */
  readonly ordinal: number;
}

export interface RenderTranscriptOptions {
  readonly detail?: TranscriptDetail;
  readonly subject?: TranscriptSubject;
}

/** Non-answer prose stays bounded at the persisted tool-output ceiling. */
const MAX_TRANSCRIPT_TEXT_CHARS = MAX_PERSISTED_TOOL_OUTPUT_CHARS;

/**
 * The once-per-file preamble. It deliberately carries no Turn count and no
 * Thread status: the file grows after this block is written, so anything that
 * changes over the child's life would be stale the moment the next Turn lands.
 */
export function renderTranscriptHeader(
  subject: TranscriptSubject | undefined,
  detail: TranscriptDetail = 'brief',
): string {
  const entries: Array<[string, string | null | undefined]> = [
    ['threadId', subject?.threadId],
    ['source', subject?.source],
    ['name', subject?.name],
    ['taskPath', subject?.taskPath],
    ['parentThreadId', subject?.parentThreadId],
    ['role', subject?.role],
    ['nickname', subject?.nickname],
    ['cwd', subject?.cwd],
  ];
  return `${[
    '# Agent Thread transcript',
    '',
    'Faithful projection of the canonical Turns of one Thread.',
    'Assistant text is verbatim; bounded payload fields carry explicit truncation markers.',
    'Appended one completed Turn at a time; a Turn still running is not here yet.',
    'Each entry is a heading, then metadata lines, then verbatim content:',
    'a heading that appears inside content is content, not structure.',
    '',
    ...entries.flatMap(([key, value]) => (value ? [`${key}: ${headerValue(value)}`] : [])),
    `detail: ${detail}`,
  ].join('\n')}\n`;
}

/**
 * One line, always.
 *
 * The header is the ONE region of this file that presents itself as structure
 * rather than as content, and some of its values are user-authored — a Thread's
 * name, an Automation's. Admission only trims those, so an interior newline
 * survives, and a name like `report\ncwd: /tmp` would write a second header line
 * that no reader could tell from a real one. Content is exempt from this on
 * purpose: below the header, verbatim is the whole point, and the preamble says
 * so.
 */
function headerValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * One Turn, as an appendable block. It leads with a blank line and ends with a
 * newline, so concatenating blocks — by append or by `renderTranscript` —
 * produces identical bytes either way.
 */
export async function renderTurn(
  turn: Turn,
  reader: TranscriptPayloadReader,
  options: RenderTurnOptions,
): Promise<string> {
  const detail = options.detail ?? 'brief';
  const lines = [
    '',
    `## Turn ${options.ordinal} — ${turn.status}`,
    `trigger: ${triggerLabel(turn)}`,
    `duration: ${turn.durationMs === null ? 'unknown' : `${turn.durationMs}ms`}`,
    `model: ${turn.execution.modelProvider}/${turn.execution.model} (${turn.execution.reasoningEffort})`,
    `tokens: ${usageLabel(turn.execution.usage)}`,
  ];
  if (detail === 'full') lines.push(`turnId: ${turn.id}`, `itemsView: ${turn.itemsView}`);
  if (turn.error) lines.push(`error: ${errorLabel(turn)}`);
  if (turn.itemsView !== 'full') {
    lines.push(`[Items were not loaded at projection time: itemsView=${turn.itemsView}]`);
  }
  if (detail === 'full') lines.push(...await providerCallLines(turn, reader));

  // Items resolve concurrently but stay in canonical order: on the rebuild path a
  // whole history's payload reads would otherwise run strictly one at a time.
  const rendered = await Promise.all(turn.items.map((item) => itemLines(item, reader, detail)));
  for (const item of rendered) lines.push('', ...item);
  return `${lines.join('\n')}\n`;
}

/** Whole-Thread rendering: byte-identical to the header plus one append per Turn. */
export async function renderTranscript(
  turns: readonly Turn[],
  reader: TranscriptPayloadReader,
  options: RenderTranscriptOptions = {},
): Promise<string> {
  const detail = options.detail ?? 'brief';
  let text = renderTranscriptHeader(options.subject, detail);
  for (const [index, turn] of turns.entries()) {
    text += await renderTurn(turn, reader, { detail, ordinal: index + 1 });
  }
  if (turns.length === 0) text += '\nNo Turns are persisted for this Thread yet.\n';
  return text;
}

function triggerLabel(turn: Turn): string {
  const trigger = turn.provenance.trigger;
  switch (trigger.kind) {
    case 'user': return 'user';
    case 'subagent': return `subagent (parent ${trigger.parentThreadId})`;
    case 'feature': return trigger.ref ? `feature ${trigger.feature} (${trigger.ref})` : `feature ${trigger.feature}`;
  }
}

interface TokenUsageFields {
  readonly totalTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One usage format for the Turn header and for per-provider-call lines. */
function usageLabel(usage: TokenUsageFields): string {
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
    const tokens = usage ? usageLabel(usage) : 'usage unavailable';
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
        item.text,
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
      const name = modelCallDisplayName(item.modelCall);
      const args = await transcriptToolArguments(item, reader);
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
        `args: ${bounded(jsonLine(args), MAX_PERSISTED_TOOL_ARGUMENT_CHARS)}`,
        ...(item.modelCall.disposition === 'redactedReplay'
          ? [`redactedPaths: ${jsonLine(item.modelCall.redactedPaths)}`]
          : []),
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

async function transcriptToolArguments(
  item: Extract<ThreadItem, { readonly modelCall: unknown }>,
  reader: TranscriptPayloadReader,
): Promise<import('../../../core/agent/protocol').JsonValue> {
  if (item.modelCall.disposition === 'evidenceOnly') {
    return item.modelCall.redactedArgumentsSummary;
  }
  const source = modelCallArgumentSource(item.modelCall);
  if (source.storage === 'inline') return source.value;
  const payload = await reader.readContext(source.ref).catch(() => null);
  if (payload?.kind !== 'toolCallArguments') return { unavailablePayloadRef: source.ref.id };
  const projected = await projectLargeTextArgumentsForDisplay(
    payload,
    source.internalTextRefs,
    reader.readInternalTextProjection ?? (async () => null),
  );
  return projected ?? { unavailablePayloadRef: source.ref.id };
}

function userContentText(content: readonly ThreadUserContent[]): string {
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'attachment') {
      return `[Attachment: ${part.name} (${part.mimeType}, ${part.sizeBytes} bytes)]`;
    }
    if (part.type === 'threadReference') return `[[thread://${part.threadId}]]`;
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

/** The identity line the provider sees, from the provider's own helper — never a copy of it. */
function imageOutputLines(item: DynamicToolCallThreadItem): string[] {
  return (item.contentItems ?? []).flatMap((part) => (part.type === 'image'
    ? [dynamicToolImageIdentity(part)]
    : []));
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
 *
 * The cap counts UTF-16 code units, so a boundary can land between the halves of
 * an astral character (emoji, rarer CJK). Keeping the lone high surrogate would
 * persist U+FFFD and make the dropped-byte count a measurement of the corruption
 * rather than of the content, so the split backs off one unit instead.
 */
function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = maxChars > 0 && isHighSurrogate(value.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  const kept = value.slice(0, end);
  return `${kept}\n[truncated ${Buffer.byteLength(value) - Buffer.byteLength(kept)} bytes]`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
