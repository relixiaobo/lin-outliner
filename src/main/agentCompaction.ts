import { isContextOverflow } from '@earendil-works/pi-ai';
import path from 'node:path';
import { isHiddenAgentContextBlock, SYSTEM_REMINDER_START, systemReminder } from '../core/agentAttachments';
import type { AgentMessage as Message, AssistantMessage, TextContent, ToolResultMessage, UserMessage } from '../core/agentTypes';
import type { PostCompactRestoredFile } from './agentLocalTools';

const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+([\s\S]*))?$/;
const DEFAULT_TRANSCRIPT_CHAR_BUDGET = 360_000;
const COMPACT_PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]';
const TOKEN_BYTES_ESTIMATE = 4;

export type CompactPromptMode = 'full' | 'up_to';

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use file, shell, web, skill, or any other tool.
- You already have all the context you need in the transcript below.
- Tool calls are unavailable for this compact request and would fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`;

const DETAILED_ANALYSIS_INSTRUCTIONS = `Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis, chronologically inspect the transcript and identify:

- The user's explicit requests, decisions, corrections, and preferences.
- The assistant's actions, tool results, edits, and reasoning-relevant outcomes.
- Outliner context: outline nodes, document structure, selected/focused content, schemas, searches, settings, or UI state when relevant.
- Files, code, commands, tests, errors, and architectural decisions when the work involves implementation.
- The exact current state needed to continue without asking the user to restate context.

Double-check that the summary distinguishes completed work from pending work and does not invent details not present in the transcript.`;

const SUMMARY_SECTIONS = `Your final summary must be wrapped in <summary> tags and include:

1. Primary Request and Intent: capture the user's explicit requests and the latest intent.
2. Key Context and Decisions: preserve important decisions, constraints, preferences, outliner context, and technical concepts.
3. Files, Nodes, and Code Sections: list relevant files, outline nodes, schemas, searches, settings, code sections, or UI areas examined or changed, with why they matter.
4. Errors and Fixes: list errors, failed attempts, user corrections, and how they were handled.
5. Problem Solving: document solved problems, reasoning outcomes, and ongoing troubleshooting.
6. All User Messages: list all non-tool user messages in order, preserving intent changes and feedback.
7. Pending Tasks: list tasks the user explicitly asked for that are not completed.
8. Current Work: describe precisely what was being worked on immediately before compaction.
9. Optional Next Step: include only the next step that directly follows from the most recent explicit user request; do not revive old or unrelated tasks.`;

const UP_TO_SUMMARY_SECTIONS = `Your final summary must be wrapped in <summary> tags and include:

1. Primary Request and Intent: capture the user's explicit requests and intent from the shown transcript.
2. Key Context and Decisions: preserve important decisions, constraints, preferences, outliner context, and technical concepts.
3. Files, Nodes, and Code Sections: list relevant files, outline nodes, schemas, searches, settings, code sections, or UI areas examined or changed, with why they matter.
4. Errors and Fixes: list errors, failed attempts, user corrections, and how they were handled.
5. Problem Solving: document solved problems, reasoning outcomes, and ongoing troubleshooting.
6. All User Messages: list all non-tool user messages from the shown transcript in order.
7. Pending Tasks: list tasks from the shown transcript that may still matter after newer preserved messages.
8. Work Completed: describe what was accomplished by the end of the shown transcript.
9. Context for Continuing Work: summarize the state, decisions, and assumptions needed to understand the preserved newer messages that will follow.`;

const FULL_COMPACT_PROMPT_BODY = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary is for a continuing assistant session where work may involve outliner editing, knowledge organization, UI state, agent skills/sub-runs, tools, files, code, tests, and product decisions. Preserve whichever of these are relevant.

${DETAILED_ANALYSIS_INSTRUCTIONS}

${SUMMARY_SECTIONS}

If there is a next step, make sure it follows directly from the most recent explicit user request.`;

const UP_TO_COMPACT_PROMPT_BODY = `Your task is to create a detailed summary of the transcript shown below. This summary will be placed at the start of a continuing session, and newer messages that build on this context will follow after your summary verbatim. You do not see those newer messages here.
Summarize thoroughly so that the assistant can read your summary plus the preserved newer messages and continue naturally.

This summary is for a continuing assistant session where work may involve outliner editing, knowledge organization, UI state, agent skills/sub-runs, tools, files, code, tests, and product decisions. Preserve whichever of these are relevant.

${DETAILED_ANALYSIS_INSTRUCTIONS}

${UP_TO_SUMMARY_SECTIONS}`;

export function parseCompactSlashCommand(input: string): { instructions: string } | null {
  const match = COMPACT_COMMAND_PATTERN.exec(input.trim());
  if (!match) return null;
  return { instructions: (match[1] ?? '').trim() };
}

export function buildCompactPrompt(
  customInstructions?: string,
  mode: CompactPromptMode = 'full',
): string {
  const instructions = customInstructions?.trim();
  const body = mode === 'up_to' ? UP_TO_COMPACT_PROMPT_BODY : FULL_COMPACT_PROMPT_BODY;
  return [
    NO_TOOLS_PREAMBLE,
    body,
    instructions ? `Additional Instructions:\n${instructions}` : null,
    'REMINDER: Do NOT call any tools. Respond with plain text only: an <analysis> block followed by a <summary> block. Tool calls are unavailable and would fail this compact request.',
  ].filter(Boolean).join('\n\n');
}

export function buildCompactionTranscript(
  messages: readonly Message[],
  charBudget = DEFAULT_TRANSCRIPT_CHAR_BUDGET,
): { transcript: string; truncated: boolean } {
  const entries = messages
    .map((message, index) => renderTranscriptMessage(message, index + 1))
    .filter(Boolean);
  let transcript = entries.join('\n\n');
  if (transcript.length <= charBudget) return { transcript, truncated: false };

  transcript = transcript.slice(transcript.length - charBudget);
  const firstBoundary = transcript.indexOf('\n\n');
  if (firstBoundary >= 0) transcript = transcript.slice(firstBoundary + 2);
  return {
    transcript: `[earlier conversation truncated for compact request]\n\n${transcript}`,
    truncated: true,
  };
}

export function buildCompactSummaryRequest(
  messages: readonly Message[],
  customInstructions?: string,
  options: {
    charBudget?: number;
    mode?: CompactPromptMode;
  } = {},
): UserMessage {
  const { transcript, truncated } = buildCompactionTranscript(messages, options.charBudget);
  const compactPrompt = buildCompactPrompt(customInstructions, options.mode);
  const truncationNote = truncated
    ? '\n\nThe transcript was too large, so the oldest rendered text was truncated before this compact request.'
    : '';
  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{
      type: 'text',
      text: `${compactPrompt}${truncationNote}\n\n<conversation>\n${transcript}\n</conversation>`,
    }],
  };
}

export function truncateCompactMessagesForPromptTooLongRetry(
  messages: readonly Message[],
  errorText?: string | null,
): Message[] | null {
  const input = messages[0]?.role === 'user' && userContentText(messages[0]).trim() === COMPACT_PTL_RETRY_MARKER
    ? messages.slice(1)
    : [...messages];
  const groups = groupMessagesByApiRound(input);
  if (groups.length < 2) return null;

  const tokenGap = parsePromptTooLongTokenGap(errorText ?? '');
  let dropCount = 0;
  if (tokenGap !== null) {
    let droppedTokens = 0;
    for (const group of groups) {
      dropCount += 1;
      droppedTokens += roughMessagesTokenCount(group);
      if (droppedTokens >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }
  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const sliced = groups.slice(dropCount).flat();
  if (sliced[0]?.role === 'assistant') {
    return [{
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: COMPACT_PTL_RETRY_MARKER }],
    }, ...sliced];
  }
  return sliced;
}

export function splitReactiveCompactMessages(
  messages: readonly Message[],
): { messagesToSummarize: Message[]; messagesToKeep: Message[] } {
  const compactable = stripTrailingContextError(messages);
  const tailStart = findReactiveTailStart(compactable);
  if (tailStart === null) {
    return {
      messagesToSummarize: [...compactable],
      messagesToKeep: [],
    };
  }
  return {
    messagesToSummarize: tailStart > 0 ? compactable.slice(0, tailStart) : [...compactable],
    messagesToKeep: compactable.slice(tailStart),
  };
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(formatted);
  if (summaryMatch) formatted = summaryMatch[1]?.trim() ?? '';
  return formatted.replace(/\n{3,}/g, '\n\n').trim();
}

// PERSISTED FORMAT SURFACE. These strings are written into durable transcripts and
// payloads (the post-compact reminder message) and parsed back verbatim by
// extractCompactSummaryFromReminder below. Changing any wording is a format change:
// summaries already on disk would silently stop extracting, with no error and no red
// test (the round-trip tests share these constants). Pre-release policy applies — on a
// wording change, wipe ~/.lin-outliner-* dev userData rather than ship a dual reader.
const COMPACT_REMINDER_PREAMBLE = 'This session is being continued from a previous conversation that was compacted. The summary below covers the earlier portion of the conversation.';
const COMPACT_REMINDER_RECENT_PRESERVED = 'Recent messages after this summary are preserved verbatim in the conversation context.';
const COMPACT_REMINDER_CONTINUE = 'Continue from where the session left off. Do not ask the user to restate context that is present in this summary.';

export function compactSummaryReminder(summary: string, recentMessagesPreserved = false): string {
  return systemReminder([
    COMPACT_REMINDER_PREAMBLE,
    formatCompactSummary(summary),
    recentMessagesPreserved ? COMPACT_REMINDER_RECENT_PRESERVED : null,
    COMPACT_REMINDER_CONTINUE,
  ].filter(Boolean).join('\n\n'));
}

/**
 * Inverse of {@link compactSummaryReminder}: recover the summary body from a post-compact
 * hidden reminder block, or null when the text is not a compaction reminder. After a
 * transcript payload is superseded by compaction, this reminder is the only durable carrier
 * of the pre-compaction content — readers that filter hidden boilerplate must still surface
 * it as evidence.
 *
 * The preamble must sit at the very start of the reminder body (where the producer above
 * always puts it) and the continue-trailer must be present. Anchoring matters: hidden
 * blocks carry arbitrary content (memory facts, outline text), and an unanchored substring
 * match would misclassify any block that merely QUOTES the preamble — leaking that block's
 * hidden context into Dream evidence on every turn.
 */
/**
 * The one rendering of a compaction reminder as evidence text, shared by the
 * Dream transcript renderer and the past-chats evidence reader (the §13.17
 * surviving-carrier invariant must surface identically in both).
 */
export function compactedSpanEvidenceText(reminderText: string): string | null {
  const summary = extractCompactSummaryFromReminder(reminderText);
  return summary ? `[summary of compacted earlier messages]\n${summary}` : null;
}

export function extractCompactSummaryFromReminder(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(SYSTEM_REMINDER_START)) return null;
  const body = trimmed.slice(SYSTEM_REMINDER_START.length).trimStart();
  if (!body.startsWith(COMPACT_REMINDER_PREAMBLE)) return null;
  let summary = body.slice(COMPACT_REMINDER_PREAMBLE.length);
  const continueIndex = summary.indexOf(COMPACT_REMINDER_CONTINUE);
  if (continueIndex < 0) return null;
  summary = summary.slice(0, continueIndex);
  const preservedIndex = summary.indexOf(COMPACT_REMINDER_RECENT_PRESERVED);
  if (preservedIndex >= 0) summary = summary.slice(0, preservedIndex);
  const result = summary.trim();
  return result || null;
}

export function createPostCompactMessage(
  summary: string,
  invokedSkillsReminder?: UserMessage | null,
  skillListingStateReminder?: UserMessage | null,
  agentListingStateReminder?: UserMessage | null,
  restoredFilesReminder?: UserMessage | null,
  options: {
    recentMessagesPreserved?: boolean;
  } = {},
): UserMessage {
  const content: TextContent[] = [
    { type: 'text', text: 'Conversation compacted.' },
    { type: 'text', text: compactSummaryReminder(summary, !!options.recentMessagesPreserved) },
  ];
  const invokedSkillText = firstText(invokedSkillsReminder);
  if (invokedSkillText) content.push({ type: 'text', text: invokedSkillText });
  const skillListingStateText = firstText(skillListingStateReminder);
  if (skillListingStateText) content.push({ type: 'text', text: skillListingStateText });
  const agentListingStateText = firstText(agentListingStateReminder);
  if (agentListingStateText) content.push({ type: 'text', text: agentListingStateText });
  const restoredFilesText = firstText(restoredFilesReminder);
  if (restoredFilesText) content.push({ type: 'text', text: restoredFilesText });
  return {
    role: 'user',
    timestamp: Date.now(),
    content,
  };
}

export function createPostCompactRestoredFilesReminder(files: readonly PostCompactRestoredFile[]): UserMessage | null {
  if (files.length === 0) return null;
  const sections = files.map((file) => [
    `File: ${file.filePath}`,
    file.truncated
      ? `Content restored below is truncated to ${file.content.length} of ${file.totalChars} chars. Call file_read before editing content not shown here.`
      : `Content restored below is complete (${file.totalChars} chars).`,
    file.content,
  ].join('\n'));
  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{
      type: 'text',
      text: systemReminder([
        'Recent file context restored after compaction. These files were read before compaction and are restored so you can continue without asking the user to restate file contents.',
        'If a file may have changed since this reminder, call file_read again before relying on it.',
        ...sections,
      ].join('\n\n')),
    }],
  };
}

export function collectPreservedFileReadPaths(messages: readonly Message[]): Set<string> {
  const unchangedReadToolIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'file_read' || !message.toolCallId) continue;
    if (isUnchangedFileReadResult(message)) unchangedReadToolIds.add(message.toolCallId);
  }

  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || part.name !== 'file_read') continue;
      if (unchangedReadToolIds.has(part.id)) continue;
      const filePath = part.arguments?.file_path;
      if (typeof filePath === 'string' && filePath.trim()) {
        paths.add(path.resolve(filePath));
      }
    }
  }
  return paths;
}

export function assistantMessageText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

function renderTranscriptMessage(message: Message, index: number): string {
  if (message.role === 'user') {
    const text = renderUserContent(message.content);
    return text ? `## ${index}. User\n${text}` : '';
  }
  if (message.role === 'assistant') {
    const text = renderAssistantContent(message);
    return text ? `## ${index}. Assistant\n${text}` : '';
  }
  const text = renderToolResultContent(message);
  return text ? `## ${index}. Tool Result (${message.toolName})\n${text}` : '';
}

function groupMessagesByApiRound(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && current.length > 0) {
      groups.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function roughMessagesTokenCount(messages: readonly Message[]): number {
  const text = messages
    .map((message, index) => renderTranscriptMessage(message, index + 1))
    .join('\n\n');
  return Math.ceil(new TextEncoder().encode(text).byteLength / TOKEN_BYTES_ESTIMATE);
}

function parsePromptTooLongTokenGap(errorText: string): number | null {
  const lower = errorText.toLowerCase();
  if (!lower.includes('token') && !lower.includes('context') && !lower.includes('prompt')) return null;

  const actualLimitPatterns = [
    /(?:actual|requested|input|messages? resulted in)\D+(\d[\d,]*)\D+(?:limit|maximum|max|allowed)\D+(\d[\d,]*)/i,
    /(?:limit|maximum|max|allowed)\D+(\d[\d,]*)\D+(?:actual|requested|input|messages? resulted in)\D+(\d[\d,]*)/i,
    /(\d[\d,]*)\s*(?:>|exceeds|exceeded|over)\s*(\d[\d,]*)/i,
  ];
  for (const pattern of actualLimitPatterns) {
    const match = pattern.exec(errorText);
    if (!match) continue;
    const first = parseTokenInt(match[1]);
    const second = parseTokenInt(match[2]);
    if (first === null || second === null) continue;
    const gap = first >= second ? first - second : second - first;
    if (gap > 0) return Math.ceil(gap * 1.15);
  }
  return null;
}

function parseTokenInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stripTrailingContextError(messages: readonly Message[]): Message[] {
  const copy = [...messages];
  const last = copy.at(-1);
  if (
    last?.role === 'assistant'
    && (last.stopReason === 'error' || last.errorMessage)
    && isContextOverflow(last)
  ) {
    copy.pop();
  }
  return copy;
}

function findReactiveTailStart(messages: readonly Message[]): number | null {
  const last = messages.at(-1);
  if (!last) return null;
  if (last.role === 'user') return messages.length - 1;
  if (last.role !== 'toolResult') return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return index;
    if (message?.role === 'user') return index + 1 < messages.length ? index + 1 : null;
  }
  return null;
}

function renderUserContent(content: UserMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  return content
    .flatMap((part) => {
      if (part.type === 'image') return ['[image omitted from compact transcript]'];
      if (isHiddenAgentContextBlock(part.text)) return [];
      return [part.text.trim()];
    })
    .filter(Boolean)
    .join('\n\n');
}

function userContentText(message: UserMessage): string {
  return renderUserContent(message.content);
}

function renderAssistantContent(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text.trim());
    if (part.type === 'thinking') parts.push('[thinking omitted from compact transcript]');
    if (part.type === 'toolCall') {
      parts.push(`Tool call: ${part.name} ${JSON.stringify(part.arguments)}`);
    }
  }
  if (message.errorMessage) parts.push(`Error: ${message.errorMessage}`);
  return parts.filter(Boolean).join('\n\n');
}

function renderToolResultContent(message: ToolResultMessage): string {
  const content = typeof message.content === 'string'
    ? message.content
    : message.content
        .flatMap((part) => part.type === 'text' ? [part.text] : ['[image omitted from compact transcript]'])
        .join('\n\n');
  const trimmed = content.trim();
  if (!trimmed) return message.isError ? '[tool returned an error without text]' : '';
  return message.isError ? `[error]\n${trimmed}` : trimmed;
}

function firstText(message?: UserMessage | null): string | null {
  if (!message) return null;
  if (typeof message.content === 'string') return message.content.trim() || null;
  return message.content.find((part): part is TextContent => part.type === 'text')?.text ?? null;
}

function isUnchangedFileReadResult(message: Message): boolean {
  if (message.role !== 'toolResult') return false;
  for (const part of message.content) {
    if (part.type !== 'text') continue;
    const parsed = parseJsonObject(part.text);
    if (
      parsed
      && parsed.tool === 'file_read'
      && (parsed.status === 'unchanged' || (isRecord(parsed.data) && parsed.data.type === 'file_unchanged'))
    ) {
      return true;
    }
  }
  return false;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
