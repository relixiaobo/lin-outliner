import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type {
  AgentEventMessageRecord,
  AgentPayloadRef,
  AgentPersistedContent,
} from '../core/agentEventLog';
import type { AgentMessage } from '../core/agentTypes';

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;
export const MAX_TOOL_RESULTS_PER_BATCH_CHARS = 200_000;
export const TOOL_OUTPUT_PREVIEW_CHARS = 2_000;
export const OLD_TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]';

const TOOL_OUTPUT_TOKEN_BYTES = 4;
const IMAGE_TOKEN_ESTIMATE = 2_000;
const COMPACTABLE_TOOL_NAMES = new Set([
  'bash',
  'file_read',
  'file_glob',
  'file_grep',
  'file_edit',
  'file_write',
  'web_search',
  'web_fetch',
]);

export interface ToolResultBudgetState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export interface ToolResultBudgetCandidate {
  messageId: string;
  toolCallId: string;
  toolName: string;
  contentText: string;
  size: number;
}

export type AgentMessageToolResultBudgetCandidate = ToolResultBudgetCandidate & {
  messageIndex: number;
};

export interface ToolResultBudgetSelection {
  toPersist: ToolResultBudgetCandidate[];
  alreadyReplaced: Array<ToolResultBudgetCandidate & { replacement: string }>;
}

export interface AgentMessageToolResultBudgetSelection {
  toPersist: AgentMessageToolResultBudgetCandidate[];
  alreadyReplaced: Array<AgentMessageToolResultBudgetCandidate & { replacement: string }>;
}

export function createToolResultBudgetState(): ToolResultBudgetState {
  return {
    seenIds: new Set(),
    replacements: new Map(),
  };
}

/**
 * The content a tool result currently presents to the *model*: its slimmed copy
 * once one exists, else the full canonical content. Slim-decision logic reasons
 * about the model's view (the canonical `content` stays full), so "already
 * slimmed?" tests must read this — else a slimmed result looks fresh every turn
 * and re-emits `tool_result.replaced` forever.
 */
export function modelFacingContent(message: AgentEventMessageRecord): readonly AgentPersistedContent[] {
  return message.modelSlimmedContent ?? message.content;
}

export function restoreToolResultBudgetStateFromMessages(
  messages: readonly AgentEventMessageRecord[],
): ToolResultBudgetState {
  const state = createToolResultBudgetState();
  for (const message of messages) {
    if (message.role !== 'toolResult' || !message.toolCallId) continue;
    state.seenIds.add(message.toolCallId);
    const replacement = persistedToolOutputReplacement(modelFacingContent(message));
    if (replacement) state.replacements.set(message.toolCallId, replacement);
  }
  return state;
}

export function restoreToolResultBudgetStateFromAgentMessages(
  messages: readonly AgentMessage[],
): ToolResultBudgetState {
  const state = createToolResultBudgetState();
  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    state.seenIds.add(message.toolCallId);
    const replacement = persistedPiToolOutputReplacement(message.content);
    if (replacement) state.replacements.set(message.toolCallId, replacement);
  }
  return state;
}

export function buildPersistedToolOutputMessage(payload: AgentPayloadRef, text: string): string {
  const preview = text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  const clipped = text.length > preview.length;
  return [
    '<persisted-output>',
    `Output too large (${formatByteSize(payload.byteLength)}). Full output saved as payload: ${payload.id}`,
    '',
    `Preview (first ${TOOL_OUTPUT_PREVIEW_CHARS} chars):`,
    clipped ? `${preview}\n...` : preview,
    '</persisted-output>',
  ].join('\n');
}

export function summarizeTextPayload(text: string, prefix: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const preview = normalized.length > 240 ? `${normalized.slice(0, 240).trim()}...` : normalized;
  return preview ? `${prefix}: ${preview}` : prefix;
}

export function piToolResultTextContent(content: readonly (TextContent | ImageContent)[]): string | null {
  if (content.some((part) => part.type !== 'text')) return null;
  return content
    .map((part) => part.type === 'text' ? part.text : '')
    .join('\n\n');
}

export function persistedContentModelText(content: readonly AgentPersistedContent[]): string {
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'thinking') return part.thinking;
    if (part.type === 'toolCall') return `[tool:${part.name}]`;
    if (part.type === 'image') return part.alt ?? part.imageRef.summary ?? `[image:${part.imageRef.id}]`;
    return part.label ?? part.payload.summary ?? `[payload:${part.payload.id}]`;
  }).join('\n\n');
}

export function estimateAgentMessagesTokens(messages: readonly AgentMessage[], systemPrompt?: string): number {
  let total = roughTokenCount(systemPrompt ?? '');
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'toolResult') {
      total += estimateUserLikeContentTokens(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') total += roughTokenCount(part.text);
      else if (part.type === 'thinking') total += roughTokenCount(part.thinking);
      else if (part.type === 'toolCall') total += roughTokenCount(`${part.name} ${JSON.stringify(part.arguments ?? {})}`);
    }
  }
  return Math.ceil(total * (4 / 3));
}

export function collectToolResultBudgetSelections(
  messages: readonly AgentEventMessageRecord[],
  state: ToolResultBudgetState,
  options: {
    limit?: number;
    skipToolNames?: ReadonlySet<string>;
  } = {},
): ToolResultBudgetSelection {
  const limit = options.limit ?? MAX_TOOL_RESULTS_PER_BATCH_CHARS;
  const skipToolNames = options.skipToolNames ?? new Set<string>();
  const batches = collectToolResultBatches(messages);
  const toPersist: ToolResultBudgetCandidate[] = [];
  const alreadyReplaced: Array<ToolResultBudgetCandidate & { replacement: string }> = [];

  for (const candidates of batches) {
    const fresh: ToolResultBudgetCandidate[] = [];
    const frozen: ToolResultBudgetCandidate[] = [];
    for (const candidate of candidates) {
      const replacement = state.replacements.get(candidate.toolCallId);
      if (replacement !== undefined) {
        alreadyReplaced.push({ ...candidate, replacement });
        continue;
      }
      if (state.seenIds.has(candidate.toolCallId)) {
        frozen.push(candidate);
        continue;
      }
      if (skipToolNames.has(candidate.toolName)) {
        state.seenIds.add(candidate.toolCallId);
        continue;
      }
      fresh.push(candidate);
    }

    if (fresh.length === 0) continue;
    const frozenSize = frozen.reduce((sum, candidate) => sum + candidate.size, 0);
    const freshSize = fresh.reduce((sum, candidate) => sum + candidate.size, 0);
    const selected = frozenSize + freshSize > limit
      ? selectLargestFreshResults(fresh, frozenSize, limit)
      : [];
    const selectedIds = new Set(selected.map((candidate) => candidate.toolCallId));
    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.toolCallId)) state.seenIds.add(candidate.toolCallId);
    }
    toPersist.push(...selected);
  }

  return { toPersist, alreadyReplaced };
}

export function collectAgentMessageToolResultBudgetSelections(
  messages: readonly AgentMessage[],
  state: ToolResultBudgetState,
  options: {
    limit?: number;
    skipToolNames?: ReadonlySet<string>;
  } = {},
): AgentMessageToolResultBudgetSelection {
  const limit = options.limit ?? MAX_TOOL_RESULTS_PER_BATCH_CHARS;
  const skipToolNames = options.skipToolNames ?? new Set<string>();
  const batches = collectAgentMessageToolResultBatches(messages);
  const toPersist: AgentMessageToolResultBudgetCandidate[] = [];
  const alreadyReplaced: Array<AgentMessageToolResultBudgetCandidate & { replacement: string }> = [];

  for (const candidates of batches) {
    const fresh: AgentMessageToolResultBudgetCandidate[] = [];
    const frozen: AgentMessageToolResultBudgetCandidate[] = [];
    for (const candidate of candidates) {
      const replacement = state.replacements.get(candidate.toolCallId);
      if (replacement !== undefined) {
        alreadyReplaced.push({ ...candidate, replacement });
        continue;
      }
      if (state.seenIds.has(candidate.toolCallId)) {
        frozen.push(candidate);
        continue;
      }
      if (skipToolNames.has(candidate.toolName)) {
        state.seenIds.add(candidate.toolCallId);
        continue;
      }
      fresh.push(candidate);
    }

    if (fresh.length === 0) continue;
    const frozenSize = frozen.reduce((sum, candidate) => sum + candidate.size, 0);
    const freshSize = fresh.reduce((sum, candidate) => sum + candidate.size, 0);
    const selected = frozenSize + freshSize > limit
      ? selectLargestFreshResults(fresh, frozenSize, limit)
      : [];
    const selectedIds = new Set(selected.map((candidate) => candidate.toolCallId));
    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.toolCallId)) state.seenIds.add(candidate.toolCallId);
    }
    toPersist.push(...selected);
  }

  return { toPersist, alreadyReplaced };
}

export function collectMicrocompactCandidates(
  messages: readonly AgentEventMessageRecord[],
  keepRecent: number,
): ToolResultBudgetCandidate[] {
  const candidates = messages
    .filter((message): message is AgentEventMessageRecord & { toolCallId: string; toolName: string } => (
      message.role === 'toolResult'
      && typeof message.toolCallId === 'string'
      && typeof message.toolName === 'string'
      && isCompactableTool(message.toolName)
      && persistedContentModelText(modelFacingContent(message)) !== OLD_TOOL_RESULT_CLEARED_MESSAGE
    ))
    .map((message): ToolResultBudgetCandidate => {
      const contentText = persistedContentModelText(modelFacingContent(message));
      return {
        messageId: message.id,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        contentText,
        size: contentText.length,
      };
    });
  const keep = Math.max(1, keepRecent);
  return candidates.slice(0, Math.max(0, candidates.length - keep));
}

export function isCompactableTool(toolName: string): boolean {
  return COMPACTABLE_TOOL_NAMES.has(toolName);
}

export function roughTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).byteLength / TOOL_OUTPUT_TOKEN_BYTES);
}

function collectToolResultBatches(
  messages: readonly AgentEventMessageRecord[],
): ToolResultBudgetCandidate[][] {
  const batches: ToolResultBudgetCandidate[][] = [];
  let current: ToolResultBudgetCandidate[] | null = null;
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (current?.length) batches.push(current);
      current = message.content.some((part) => part.type === 'toolCall') ? [] : null;
      continue;
    }
    if (message.role === 'toolResult' && current && message.toolCallId && message.toolName) {
      // Size by the MODEL-facing copy, not canonical `content`. Since the slim
      // decouple keeps `content` full forever, an already-slimmed result (offloaded
      // payload_ref or microcompact-cleared) must contribute its slim size here —
      // otherwise its full size inflates `frozenSize` and forces fresh results to be
      // offloaded earlier than the real model-facing budget warrants (cache churn).
      // Mirrors collectMicrocompactCandidates / restoreToolResultBudgetStateFromMessages.
      const contentText = persistedContentModelText(modelFacingContent(message));
      current.push({
        messageId: message.id,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        contentText,
        size: contentText.length,
      });
      continue;
    }
    if (current?.length) batches.push(current);
    current = null;
  }
  if (current?.length) batches.push(current);
  return batches;
}

function collectAgentMessageToolResultBatches(
  messages: readonly AgentMessage[],
): AgentMessageToolResultBudgetCandidate[][] {
  const batches: AgentMessageToolResultBudgetCandidate[][] = [];
  let current: AgentMessageToolResultBudgetCandidate[] | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      if (current?.length) batches.push(current);
      current = message.content.some((part) => part.type === 'toolCall') ? [] : null;
      continue;
    }
    if (message.role === 'toolResult' && current) {
      const contentText = piToolResultTextContent(message.content);
      if (contentText !== null) {
        current.push({
          messageId: `message-${index}`,
          messageIndex: index,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          contentText,
          size: contentText.length,
        });
      }
      continue;
    }
    if (current?.length) batches.push(current);
    current = null;
  }
  if (current?.length) batches.push(current);
  return batches;
}

function persistedToolOutputReplacement(content: readonly AgentPersistedContent[]): string | null {
  for (const part of content) {
    if (
      part.type === 'payload_ref'
      && part.payload.role === 'tool_output'
      && typeof part.label === 'string'
      && part.label.startsWith('<persisted-output>')
    ) {
      return part.label;
    }
  }
  return null;
}

function persistedPiToolOutputReplacement(content: readonly (TextContent | ImageContent)[]): string | null {
  const text = piToolResultTextContent(content);
  return text?.trim().startsWith('<persisted-output>') ? text : null;
}

function selectLargestFreshResults<T extends ToolResultBudgetCandidate>(
  fresh: readonly T[],
  frozenSize: number,
  limit: number,
): T[] {
  const sorted = [...fresh].sort((left, right) => right.size - left.size);
  const selected: T[] = [];
  let remaining = frozenSize + fresh.reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of sorted) {
    if (remaining <= limit) break;
    selected.push(candidate);
    remaining -= candidate.size;
  }
  return selected;
}

function estimateUserLikeContentTokens(content: AgentMessage['content']): number {
  if (typeof content === 'string') return roughTokenCount(content);
  return content.reduce((sum, part) => {
    if (part.type === 'text') return sum + roughTokenCount(part.text);
    if (part.type === 'image') return sum + IMAGE_TOKEN_ESTIMATE;
    return sum;
  }, 0);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
