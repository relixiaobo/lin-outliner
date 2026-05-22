import { isContextOverflow } from '@earendil-works/pi-ai';
import path from 'node:path';
import { isHiddenAgentContextBlock, systemReminder } from '../core/agentAttachments';
import type { AgentMessage as Message, AssistantMessage, TextContent, ToolResultMessage, UserMessage } from '../core/agentTypes';
import type { PostCompactRestoredFile } from './agentLocalTools';

const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+([\s\S]*))?$/;
const DEFAULT_TRANSCRIPT_CHAR_BUDGET = 360_000;
const COMPACT_PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]';
const TOKEN_BYTES_ESTIMATE = 4;

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use file, shell, web, skill, or any other tool.
- You already have all the context you need in the transcript below.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`;

const COMPACT_PROMPT_BODY = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary must preserve technical details, code patterns, file paths, architectural decisions, errors, fixes, and the current state needed to continue development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis, chronologically inspect the conversation and identify the user's requests, decisions made, files read or changed, exact implementation details, test results, errors, fixes, and the work immediately in progress.

Your final summary must be wrapped in <summary> tags and include:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

If there is a next step, make sure it follows directly from the most recent explicit user request.`;

export function parseCompactSlashCommand(input: string): { instructions: string } | null {
  const match = COMPACT_COMMAND_PATTERN.exec(input.trim());
  if (!match) return null;
  return { instructions: (match[1] ?? '').trim() };
}

export function buildCompactPrompt(customInstructions?: string): string {
  const instructions = customInstructions?.trim();
  return [
    NO_TOOLS_PREAMBLE,
    COMPACT_PROMPT_BODY,
    instructions ? `Additional Instructions:\n${instructions}` : null,
    'REMINDER: Do NOT call any tools. Respond with plain text only: an <analysis> block followed by a <summary> block.',
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
  } = {},
): UserMessage {
  const { transcript, truncated } = buildCompactionTranscript(messages, options.charBudget);
  const compactPrompt = buildCompactPrompt(customInstructions);
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

export function compactSummaryReminder(summary: string): string {
  return systemReminder([
    'This session is being continued from a previous conversation that was compacted. The summary below covers the earlier portion of the conversation.',
    formatCompactSummary(summary),
    'Continue from where the session left off. Do not ask the user to restate context that is present in this summary.',
  ].join('\n\n'));
}

export function createPostCompactMessage(
  summary: string,
  invokedSkillsReminder?: UserMessage | null,
  skillListingStateReminder?: UserMessage | null,
  agentListingStateReminder?: UserMessage | null,
  restoredFilesReminder?: UserMessage | null,
): UserMessage {
  const content: TextContent[] = [
    { type: 'text', text: 'Conversation compacted.' },
    { type: 'text', text: compactSummaryReminder(summary) },
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
