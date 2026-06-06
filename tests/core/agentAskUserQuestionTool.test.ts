import { describe, expect, test } from 'bun:test';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
} from '../../src/main/agentAskUserQuestionTool';
import type { AgentUserQuestionRequestView, AskUserQuestionResult } from '../../src/core/agentEventLog';

describe('ask user question tool', () => {
  test('normalizes structured questions and returns structured answers', async () => {
    let captured: { toolCallId: string; request: AgentUserQuestionRequestView } | null = null;
    const expected: AskUserQuestionResult = {
      requestId: 'question-1',
      answers: [{ questionId: 'direction', selectedOptionIds: ['b'] }],
    };
    const tool = createAskUserQuestionTool({
      ask: async (toolCallId, request) => {
        captured = { toolCallId, request };
        return expected;
      },
    });

    const result = await tool.execute('tool-call-1', {
      questions: [{
        id: 'direction',
        type: 'single_choice',
        header: 'Direction',
        question: 'Which path should I take?',
        options: [
          { id: 'a', label: 'A', description: 'Use approach A.' },
          { id: 'b', label: 'B', recommended: true },
        ],
      }],
      submit_label: 'Use this path',
    });

    expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME);
    expect(captured).toEqual({
      toolCallId: 'tool-call-1',
      request: {
        questions: [{
          id: 'direction',
          type: 'single_choice',
          header: 'Direction',
          question: 'Which path should I take?',
          required: true,
          allowOther: false,
          allowReferences: false,
          allowAttachments: false,
          options: [
            { id: 'a', label: 'A', description: 'Use approach A.', recommended: undefined },
            { id: 'b', label: 'B', description: undefined, recommended: true },
          ],
        }],
        submitLabel: 'Use this path',
      },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ok: true,
      data: expected,
    });
  });

  test('rejects duplicate question ids without asking runtime', async () => {
    let called = false;
    const tool = createAskUserQuestionTool({
      ask: async () => {
        called = true;
        return { requestId: 'unused', answers: [] };
      },
    });

    const result = await tool.execute('tool-call-1', {
      questions: [
        { id: 'same', type: 'free_text', question: 'First?' },
        { id: 'same', type: 'free_text', question: 'Second?' },
      ],
    });

    expect(called).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_QUESTION_ID' },
    });
  });
});
