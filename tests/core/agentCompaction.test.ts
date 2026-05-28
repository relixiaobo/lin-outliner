import { describe, expect, test } from 'bun:test';
import {
  buildCompactSummaryRequest,
  buildCompactionTranscript,
  createPostCompactMessage,
  formatCompactSummary,
  parseCompactSlashCommand,
  splitReactiveCompactMessages,
  truncateCompactMessagesForPromptTooLongRetry,
} from '../../src/main/agentCompaction';
import { systemReminder } from '../../src/core/agentAttachments';
import type { AgentMessage as Message, UserMessage } from '../../src/core/agentTypes';

describe('agent compaction', () => {
  test('parses /compact slash command with optional instructions', () => {
    expect(parseCompactSlashCommand('/compact')).toEqual({ instructions: '' });
    expect(parseCompactSlashCommand('/compact focus on tests')).toEqual({ instructions: 'focus on tests' });
    expect(parseCompactSlashCommand('/commit')).toBeNull();
  });

  test('renders compact transcript without hidden system reminders', () => {
    const messages: Message[] = [
      user('Visible request', systemReminder('Hidden dynamic context')),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect files.' },
          { type: 'toolCall', id: 'tool-1', name: 'file_read', arguments: { file_path: '/tmp/a.ts' } },
        ],
        api: 'openai-completions',
        provider: 'openai',
        model: 'test',
        usage: emptyUsage(),
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolName: 'file_read',
        toolCallId: 'tool-1',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 3,
      },
    ];

    const { transcript } = buildCompactionTranscript(messages);

    expect(transcript).toContain('Visible request');
    expect(transcript).not.toContain('Hidden dynamic context');
    expect(transcript).toContain('Tool call: file_read');
    expect(transcript).toContain('Tool Result (file_read)');
  });

  test('formats tagged analysis and summary output', () => {
    expect(formatCompactSummary('<analysis>scratch</analysis>\n<summary>\nFinal summary\n</summary>')).toBe('Final summary');
  });

  test('creates post-compact message with visible boundary and hidden reminders', () => {
    const invokedSkills: UserMessage = {
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: systemReminder('Invoked skill content') }],
    };
    const listingState: UserMessage = {
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: systemReminder('Listed skill state') }],
    };
    const message = createPostCompactMessage('<summary>Summary body</summary>', invokedSkills, listingState);
    const texts = Array.isArray(message.content) ? message.content.map((part) => part.type === 'text' ? part.text : '') : [];

    expect(texts[0]).toBe('Conversation compacted.');
    expect(texts[1]).toContain('<system-reminder>');
    expect(texts[1]).toContain('Summary body');
    expect(texts[2]).toContain('Invoked skill content');
    expect(texts[3]).toContain('Listed skill state');
  });

  test('marks post-compact summary when recent messages remain verbatim', () => {
    const message = createPostCompactMessage('<summary>Older context</summary>', null, null, null, null, {
      recentMessagesPreserved: true,
    });
    const texts = Array.isArray(message.content) ? message.content.map((part) => part.type === 'text' ? part.text : '') : [];

    expect(texts[1]).toContain('Older context');
    expect(texts[1]).toContain('Recent messages after this summary are preserved verbatim');
  });

  test('builds one no-tools summary request containing the transcript', () => {
    const request = buildCompactSummaryRequest([user('Summarize me')], 'keep errors');
    const text = Array.isArray(request.content) ? request.content[0]?.type === 'text' ? request.content[0].text : '' : request.content;

    expect(text).toContain('Do NOT call any tools');
    expect(text).toContain('continuing assistant session');
    expect(text).toContain('outliner editing');
    expect(text).toContain('Files, Nodes, and Code Sections');
    expect(text).toContain('Additional Instructions');
    expect(text).toContain('keep errors');
    expect(text).toContain('<conversation>');
    expect(text).toContain('Summarize me');
  });

  test('builds up-to prompt for reactive compact with preserved newer messages', () => {
    const request = buildCompactSummaryRequest([user('Older context')], undefined, { mode: 'up_to' });
    const text = Array.isArray(request.content) ? request.content[0]?.type === 'text' ? request.content[0].text : '' : request.content;

    expect(text).toContain('newer messages that build on this context will follow after your summary verbatim');
    expect(text).toContain('You do not see those newer messages here');
    expect(text).toContain('Older context');
  });

  test('truncates oldest API-round groups for compact prompt-too-long retry', () => {
    const messages: Message[] = [
      user('old request'),
      assistant('old answer'),
      user('new request'),
      assistant('new answer'),
    ];

    const truncated = truncateCompactMessagesForPromptTooLongRetry(messages, 'prompt too long');

    expect(truncated).not.toBeNull();
    expect(buildCompactionTranscript(truncated!).transcript).not.toContain('old request');
    expect(buildCompactionTranscript(truncated!).transcript).toContain('new request');
  });

  test('splits reactive compact tail so the latest user prompt survives verbatim', () => {
    const messages: Message[] = [
      user('previous request'),
      assistant('previous answer'),
      user('latest user prompt'),
      {
        ...assistant(''),
        stopReason: 'error',
        errorMessage: 'prompt too long: context length exceeded',
      },
    ];

    const split = splitReactiveCompactMessages(messages);

    expect(buildCompactionTranscript(split.messagesToSummarize).transcript).toContain('previous request');
    expect(split.messagesToKeep).toHaveLength(1);
    expect(buildCompactionTranscript(split.messagesToKeep).transcript).toContain('latest user prompt');
  });
});

function user(...texts: string[]): UserMessage {
  return {
    role: 'user',
    timestamp: 1,
    content: texts.map((text) => ({ type: 'text' as const, text })),
  };
}

function assistant(text: string): Message {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: 2,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
