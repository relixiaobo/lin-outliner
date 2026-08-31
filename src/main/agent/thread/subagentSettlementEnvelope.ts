import { createHash } from 'node:crypto';
import { estimateTextTokens } from '../context/ContextBudgetPlanner';
import { parseReferenceMarkers } from '../../../core/referenceMarkup';
import type { AgentFinalCitationBinding, ThreadResourceReference } from '../../../core/agent/protocol';
import type {
  SubagentCoverageDisposition,
  SubagentDeliveryBatchMember,
  SubagentExecutionRecord,
  SubagentPendingNotification,
  SubagentSettlementCoverage,
} from '../persistence/SubagentExecutionLedger';

export const MAX_SUBAGENT_SETTLEMENT_TOKENS = 16_384;
export const MAX_SUBAGENT_SETTLEMENT_BYTES = 65_536;
export const MAX_SUBAGENT_SETTLEMENT_MEMBERS = 20;
export const MAX_SUBAGENT_PENDING_MARKER_TOKENS = 128;
export const MAX_SUBAGENT_PENDING_MARKER_BYTES = 512;

export interface SubagentSettlementEnvelopeCandidate {
  readonly execution: SubagentExecutionRecord;
  readonly notification: SubagentPendingNotification;
  readonly output: string;
  readonly citations?: readonly AgentFinalCitationBinding[];
}

export interface SubagentSettlementEnvelope {
  readonly text: string;
  readonly digest: string;
  readonly members: readonly SubagentDeliveryBatchMember[];
  readonly coverage: SubagentHandoffCoverage;
  readonly estimatedTokens: number;
  readonly byteLength: number;
  readonly resourceRefs: readonly ThreadResourceReference[];
}

export type SubagentHandoffOrigin = SubagentSettlementCoverage['origin'] | 'foreground' | 'background';

export interface SubagentHandoffCoverage extends Omit<SubagentSettlementCoverage, 'origin'> {
  readonly origin: SubagentHandoffOrigin;
}

export type SubagentSettlementEnvelopeResult =
  | { readonly status: 'ready'; readonly envelope: SubagentSettlementEnvelope }
  | { readonly status: 'noCapacity' };

export class SubagentHandoffProjector {
  project(input: Parameters<typeof projectSubagentHandoff>[0]): SubagentSettlementEnvelopeResult {
    return projectSubagentHandoff(input);
  }
}

export function projectSubagentHandoff(input: {
  readonly batchId: string;
  readonly origin: SubagentHandoffOrigin;
  readonly candidates: readonly SubagentSettlementEnvelopeCandidate[];
  readonly mode?: 'settlement' | 'carryForward';
  readonly maxTokens?: number;
  readonly maxBytes?: number;
}): SubagentSettlementEnvelopeResult {
  if (
    input.mode === 'carryForward'
    && (input.maxTokens === 0 || input.maxBytes === 0)
  ) {
    return readyEnvelope(
      '',
      fairCandidateOrder(input.candidates)
        .map((candidate, ordinal) => omittedMember(candidate, ordinal, false)),
      input.origin,
    );
  }
  const maxTokens = boundedLimit(
    input.maxTokens ?? MAX_SUBAGENT_SETTLEMENT_TOKENS,
    MAX_SUBAGENT_SETTLEMENT_TOKENS,
    'Subagent settlement token limit',
  );
  const maxBytes = boundedLimit(
    input.maxBytes ?? MAX_SUBAGENT_SETTLEMENT_BYTES,
    MAX_SUBAGENT_SETTLEMENT_BYTES,
    'Subagent settlement byte limit',
  );
  const ordered = fairCandidateOrder(input.candidates);
  if (input.mode === 'carryForward' && ordered.length === 0) {
    return readyEnvelope('', [], input.origin);
  }
  const selected = ordered.slice(0, MAX_SUBAGENT_SETTLEMENT_MEMBERS);
  let includedCount = selected.length;
  let byteAllowance = maxBytes;
  let tokenAllowance = maxTokens;
  let rendered: RenderedEnvelope | null = null;

  while (includedCount >= 0) {
    rendered = renderWithinAllowance({
      batchId: input.batchId,
      origin: input.origin,
      selected: selected.slice(0, includedCount),
      omitted: ordered.slice(includedCount),
      maxTokens: tokenAllowance,
      maxBytes: byteAllowance,
    });
    if (rendered && rendered.byteLength <= maxBytes && rendered.estimatedTokens <= maxTokens) break;
    if (rendered) {
      byteAllowance = Math.max(1, Math.floor(byteAllowance * 0.9));
      tokenAllowance = Math.max(1, Math.floor(tokenAllowance * 0.9));
      if (byteAllowance > 256 && tokenAllowance > 64) continue;
    }
    includedCount -= 1;
    byteAllowance = maxBytes;
    tokenAllowance = maxTokens;
  }
  if (!rendered || includedCount < 0) {
    if (input.mode !== 'carryForward') return { status: 'noCapacity' };
    const marker = carryForwardPendingMarker(input.candidates.length);
    if (
      utf8Bytes(marker) > Math.min(maxBytes, MAX_SUBAGENT_PENDING_MARKER_BYTES)
      || estimateTextTokens(marker) > Math.min(maxTokens, MAX_SUBAGENT_PENDING_MARKER_TOKENS)
    ) {
      return readyEnvelope(
        '',
        ordered.map((candidate, ordinal) => omittedMember(candidate, ordinal, false)),
        input.origin,
      );
    }
    const members = ordered.map((candidate, ordinal) => omittedMember(candidate, ordinal, false));
    return readyEnvelope(marker, members, input.origin);
  }

  const dispositions = new Map(rendered.entries.map((entry) => [
    executionIdentity(entry.candidate),
    entry,
  ]));
  const members = ordered.map((candidate, ordinal): SubagentDeliveryBatchMember => {
    const renderedEntry = dispositions.get(executionIdentity(candidate));
    const source = variableSource(candidate);
    const sourceBytes = utf8Bytes(source);
    const sourceTokens = estimateTextTokens(source);
    const nested = candidate.notification.settlementCoverage;
    return {
      ordinal,
      claimed: input.mode !== 'carryForward' || renderedEntry?.disposition !== 'omitted',
      agentId: candidate.notification.agentId,
      generation: candidate.notification.generation,
      turnId: candidate.notification.turnId,
      status: candidate.notification.status,
      stopProvenance: candidate.notification.stopProvenance,
      tokensUsed: candidate.notification.tokensUsed,
      errorCode: candidate.notification.error?.code ?? null,
      sourceBytes,
      sourceTokens,
      disposition: renderedEntry?.disposition ?? 'omitted',
      omittedBytes: renderedEntry?.omittedBytes ?? sourceBytes,
      omittedTokens: renderedEntry?.omittedTokens ?? sourceTokens,
      nestedFull: nested?.full ?? 0,
      nestedExcerpted: nested?.excerpted ?? 0,
      nestedOmitted: nested?.omitted ?? 0,
    };
  });
  const coverage = coverageFor(input.origin, members, false);
  const resourceRefs = selectedHandoffReferences(rendered.entries);
  return readyEnvelope(rendered.text, members, input.origin, coverage, resourceRefs);
}

function readyEnvelope(
  text: string,
  members: readonly SubagentDeliveryBatchMember[],
  origin: SubagentHandoffOrigin,
  coverage = coverageFor(origin, members, false),
  resourceRefs: readonly ThreadResourceReference[] = [],
): Extract<SubagentSettlementEnvelopeResult, { readonly status: 'ready' }> {
  return {
    status: 'ready',
    envelope: {
      text,
      digest: createHash('sha256').update(text, 'utf8').digest('hex'),
      members: Object.freeze([...members]),
      coverage,
      estimatedTokens: text ? estimateTextTokens(text) : 0,
      byteLength: utf8Bytes(text),
      resourceRefs: Object.freeze([...resourceRefs]),
    },
  };
}

function omittedMember(
  candidate: SubagentSettlementEnvelopeCandidate,
  ordinal: number,
  claimed: boolean,
): SubagentDeliveryBatchMember {
  const source = variableSource(candidate);
  const nested = candidate.notification.settlementCoverage;
  return {
    ordinal,
    claimed,
    agentId: candidate.notification.agentId,
    generation: candidate.notification.generation,
    turnId: candidate.notification.turnId,
    status: candidate.notification.status,
    stopProvenance: candidate.notification.stopProvenance,
    tokensUsed: candidate.notification.tokensUsed,
    errorCode: candidate.notification.error?.code ?? null,
    sourceBytes: utf8Bytes(source),
    sourceTokens: estimateTextTokens(source),
    disposition: 'omitted',
    omittedBytes: utf8Bytes(source),
    omittedTokens: estimateTextTokens(source),
    nestedFull: nested?.full ?? 0,
    nestedExcerpted: nested?.excerpted ?? 0,
    nestedOmitted: nested?.omitted ?? 0,
  };
}

function carryForwardPendingMarker(count: number): string {
  return '[SYSTEM NOTIFICATION - NOT USER INPUT]\n'
    + `<subagent-output-pending count="${count}" reason="carry-forward-capacity" />`;
}

interface RenderedEntry {
  readonly candidate: SubagentSettlementEnvelopeCandidate;
  readonly content: string;
  readonly disposition: SubagentCoverageDisposition;
  readonly omittedBytes: number;
  readonly omittedTokens: number;
}

interface RenderedEnvelope {
  readonly text: string;
  readonly entries: readonly RenderedEntry[];
  readonly estimatedTokens: number;
  readonly byteLength: number;
}

function renderWithinAllowance(input: {
  readonly batchId: string;
  readonly origin: SubagentHandoffOrigin;
  readonly selected: readonly SubagentSettlementEnvelopeCandidate[];
  readonly omitted: readonly SubagentSettlementEnvelopeCandidate[];
  readonly maxTokens: number;
  readonly maxBytes: number;
}): RenderedEnvelope | null {
  const emptyEntries = input.selected.map((candidate): RenderedEntry => ({
    candidate,
    content: '',
    disposition: 'omitted',
    omittedBytes: utf8Bytes(variableSource(candidate)),
    omittedTokens: estimateTextTokens(variableSource(candidate)),
  }));
  const minimal = serializeEnvelope(input.batchId, input.origin, emptyEntries, input.omitted);
  if (minimal.byteLength > input.maxBytes || minimal.estimatedTokens > input.maxTokens) return null;

  let availableBytes = Math.max(0, input.maxBytes - minimal.byteLength - input.selected.length * 96);
  let availableTokens = Math.max(0, input.maxTokens - minimal.estimatedTokens - input.selected.length * 24);
  const pending = input.selected.map((candidate) => ({
    candidate,
    source: variableSource(candidate),
  }));
  const allocations = new Map<string, { bytes: number; tokens: number }>();
  while (pending.length > 0) {
    const byteShare = Math.floor(availableBytes / pending.length);
    const tokenShare = Math.floor(availableTokens / pending.length);
    const fullyCovered = pending.filter(({ source }) => (
      utf8Bytes(escapeXmlText(source)) <= byteShare
      && estimateTextTokens(escapeXmlText(source)) <= tokenShare
    ));
    if (fullyCovered.length === 0) {
      for (const { candidate } of pending) {
        allocations.set(executionIdentity(candidate), { bytes: byteShare, tokens: tokenShare });
      }
      break;
    }
    for (const entry of fullyCovered) {
      const escaped = escapeXmlText(entry.source);
      const bytes = utf8Bytes(escaped);
      const tokens = estimateTextTokens(escaped);
      allocations.set(executionIdentity(entry.candidate), { bytes, tokens });
      availableBytes -= bytes;
      availableTokens -= tokens;
      pending.splice(pending.indexOf(entry), 1);
    }
  }
  const entries = input.selected.map((candidate): RenderedEntry => {
    const source = variableSource(candidate);
    const allocation = allocations.get(executionIdentity(candidate)) ?? { bytes: 0, tokens: 0 };
    const excerpt = excerptForAllowance(source, allocation.bytes, allocation.tokens);
    return { candidate, ...excerpt };
  });
  return serializeEnvelope(input.batchId, input.origin, entries, input.omitted);
}

function serializeEnvelope(
  batchId: string,
  origin: SubagentHandoffOrigin,
  entries: readonly RenderedEntry[],
  omitted: readonly SubagentSettlementEnvelopeCandidate[],
): RenderedEnvelope {
  const hasIncomplete = entries.some((entry) => entry.disposition !== 'full') || omitted.length > 0;
  const lines = [
    '[SYSTEM NOTIFICATION - NOT USER INPUT]',
    'This is bounded, host-recorded delegated output for one settlement round.',
    'Each execution status says where that run stopped; it does not establish that the assignment is complete.',
    'Inspect the reported work, evidence, and gaps before deciding whether to use it, resume a named Agent, ask the user, or report a limitation.',
    ...(hasIncomplete ? [
      'Some source content is excerpted or omitted. You cannot claim that every child result was fully checked; disclose the limitation and the next concrete inspection action.',
    ] : []),
    `<subagent-settlement batch-id="${escapeXmlAttribute(batchId)}" origin="${origin}">`,
  ];
  for (const entry of entries) {
    const candidate = entry.candidate;
    const nested = candidate.notification.settlementCoverage;
    lines.push(
      `<agent-output agent-id="${escapeXmlAttribute(candidate.notification.agentId)}" generation="${candidate.notification.generation}" turn-id="${escapeXmlAttribute(candidate.notification.turnId)}">`,
      `<execution status="${candidate.notification.status}" stop-provenance="${candidate.notification.stopProvenance}" />`,
      `<nested-coverage full="${nested?.full ?? 0}" excerpted="${nested?.excerpted ?? 0}" omitted="${nested?.omitted ?? 0}" provider-attempted="${nested?.providerAttempted === true}" />`,
      ...(entry.content ? [`<output>${escapeXmlText(entry.content)}</output>`] : []),
      ...(entry.disposition === 'full' ? [] : [
        `<omission disposition="${entry.disposition}" omitted-bytes="${entry.omittedBytes}" omitted-tokens="${entry.omittedTokens}" />`,
      ]),
      '</agent-output>',
    );
  }
  if (omitted.length > 0) {
    const bytes = omitted.reduce((total, candidate) => total + utf8Bytes(variableSource(candidate)), 0);
    const tokens = omitted.reduce((total, candidate) => total + estimateTextTokens(variableSource(candidate)), 0);
    lines.push(
      `<omitted-agent-outputs count="${omitted.length}" source-bytes="${bytes}" source-tokens="${tokens}" batch-id="${escapeXmlAttribute(batchId)}" />`,
    );
  }
  if (hasIncomplete) {
    for (const candidate of [...entries.map((entry) => entry.candidate), ...omitted]) {
      lines.push(
        `<transcript-fallback agent-id="${escapeXmlAttribute(candidate.notification.agentId)}" generation="${candidate.notification.generation}" turn-id="${escapeXmlAttribute(candidate.notification.turnId)}" />`,
      );
    }
  }
  lines.push('</subagent-settlement>');
  const text = lines.join('\n');
  return {
    text,
    entries,
    estimatedTokens: estimateTextTokens(text),
    byteLength: utf8Bytes(text),
  };
}

function selectedHandoffReferences(
  entries: readonly RenderedEntry[],
): ThreadResourceReference[] {
  const selected = new Map<string, ThreadResourceReference>();
  for (const entry of entries) {
    if (entry.disposition === 'omitted') continue;
    const citations = entry.candidate.citations ?? [];
    const includedOrdinals = entry.disposition === 'full'
      ? new Set(citations.map((citation) => citation.markerOrdinal))
      : includedCitationOrdinals(entry.candidate.output, entry.content);
    for (const citation of citations) {
      if (!includedOrdinals.has(citation.markerOrdinal) || !citation.resourceRef) continue;
      selected.set(citation.resourceRef.id, citation.resourceRef);
    }
  }
  return [...selected.values()];
}

function includedCitationOrdinals(source: string, excerpt: string): Set<number> {
  const sourceMarkers = parseReferenceMarkers(source, ['file']);
  const excerptUris = new Set(parseReferenceMarkers(excerpt, ['file']).map((marker) => marker.uri));
  return new Set(sourceMarkers.flatMap((marker, ordinal) => excerptUris.has(marker.uri) ? [ordinal] : []));
}

function excerptForAllowance(
  source: string,
  maxEscapedBytes: number,
  maxEstimatedTokens: number,
): Pick<RenderedEntry, 'content' | 'disposition' | 'omittedBytes' | 'omittedTokens'> {
  const sourceBytes = utf8Bytes(source);
  const sourceTokens = estimateTextTokens(source);
  const escaped = escapeXmlText(source);
  if (utf8Bytes(escaped) <= maxEscapedBytes && estimateTextTokens(escaped) <= maxEstimatedTokens) {
    return { content: source, disposition: 'full', omittedBytes: 0, omittedTokens: 0 };
  }
  let low = 0;
  let high = sourceBytes;
  let best = '';
  while (low <= high) {
    const target = Math.floor((low + high) / 2);
    const candidate = headTailUtf8(source, target);
    const candidateEscaped = escapeXmlText(candidate);
    if (
      utf8Bytes(candidateEscaped) <= maxEscapedBytes
      && estimateTextTokens(candidateEscaped) <= maxEstimatedTokens
    ) {
      best = candidate;
      low = target + 1;
    } else {
      high = target - 1;
    }
  }
  if (!best) {
    return { content: '', disposition: 'omitted', omittedBytes: sourceBytes, omittedTokens: sourceTokens };
  }
  const retainedBytes = utf8Bytes(best);
  const retainedTokens = estimateTextTokens(best);
  return {
    content: best,
    disposition: 'excerpted',
    omittedBytes: Math.max(0, sourceBytes - retainedBytes),
    omittedTokens: Math.max(0, sourceTokens - retainedTokens),
  };
}

function headTailUtf8(value: string, byteBudget: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= byteBudget) return value;
  if (byteBudget < 8) return '';
  const marker = '\n...[excerpt]...\n';
  const markerBytes = utf8Bytes(marker);
  if (byteBudget <= markerBytes) return '';
  const contentBudget = byteBudget - markerBytes;
  const headBudget = Math.floor(contentBudget / 3);
  const tailBudget = contentBudget - headBudget;
  return `${utf8Prefix(encoded, headBudget)}${marker}${utf8Suffix(encoded, tailBudget)}`;
}

function utf8Prefix(encoded: Uint8Array, maxBytes: number): string {
  let end = Math.min(maxBytes, encoded.byteLength);
  while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end));
}

function utf8Suffix(encoded: Uint8Array, maxBytes: number): string {
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(start));
}

function variableSource(candidate: SubagentSettlementEnvelopeCandidate): string {
  return [
    `Description: ${candidate.execution.description}`,
    ...(candidate.notification.error?.messagePreview
      ? [`Error: ${candidate.notification.error.messagePreview}`]
      : []),
    ...(candidate.output ? [`Output:\n${candidate.output}`] : []),
  ].join('\n');
}

function fairCandidateOrder(
  candidates: readonly SubagentSettlementEnvelopeCandidate[],
): SubagentSettlementEnvelopeCandidate[] {
  const groups = new Map<string, SubagentSettlementEnvelopeCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.notification.agentId) ?? [];
    group.push(candidate);
    groups.set(candidate.notification.agentId, group);
  }
  const orderedGroups = [...groups.values()]
    .map((group) => group.sort((left, right) => (
      right.notification.generation - left.notification.generation
      || left.notification.createdAt - right.notification.createdAt
    )))
    .sort((left, right) => (
      Math.min(...left.map((entry) => entry.notification.createdAt))
      - Math.min(...right.map((entry) => entry.notification.createdAt))
      || left[0]!.notification.agentId.localeCompare(right[0]!.notification.agentId)
    ));
  const ordered: SubagentSettlementEnvelopeCandidate[] = [];
  for (let generationIndex = 0; ; generationIndex += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const candidate = group[generationIndex];
      if (!candidate) continue;
      ordered.push(candidate);
      added = true;
    }
    if (!added) return ordered;
  }
}

function coverageFor(
  origin: SubagentHandoffOrigin,
  members: readonly SubagentDeliveryBatchMember[],
  providerAttempted: boolean,
): SubagentHandoffCoverage {
  return {
    origin,
    full: members.filter((member) => member.disposition === 'full').length,
    excerpted: members.filter((member) => member.disposition === 'excerpted').length,
    omitted: members.filter((member) => member.disposition === 'omitted').length,
    providerAttempted,
  };
}

function executionIdentity(candidate: SubagentSettlementEnvelopeCandidate): string {
  return `${candidate.notification.agentId}\0${candidate.notification.generation}`;
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
