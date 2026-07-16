import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentUserQuestionItemView,
  AgentUserQuestionKind,
  AgentUserQuestionOptionView,
  AgentUserQuestionRequestView,
  AskUserQuestionResult,
} from '../core/agentEventLog';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import {
  optionalTruncatedStringValue,
  truncatedStringValue,
} from './agentToolParams';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

export interface AgentAskUserQuestionRuntime {
  ask(toolCallId: string, request: AgentUserQuestionRequestView, signal?: AbortSignal): Promise<AskUserQuestionResult>;
}

const ASK_USER_QUESTION_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'question'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 },
          type: { type: 'string', enum: ['single_choice', 'multi_choice', 'free_text'] },
          header: { type: 'string', minLength: 1, maxLength: 80 },
          question: { type: 'string', minLength: 1, maxLength: 500 },
          required: { type: 'boolean' },
          allow_other: { type: 'boolean' },
          allow_references: { type: 'boolean' },
          allow_attachments: { type: 'boolean' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 80 },
                label: { type: 'string', minLength: 1, maxLength: 120 },
                description: { type: 'string', minLength: 1, maxLength: 300 },
                recommended: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    submit_label: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

export function createAskUserQuestionTool(
  runtime: AgentAskUserQuestionRuntime,
): AgentTool<any, ToolEnvelope<AskUserQuestionResult>> {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    description: [
      'Ask the user for structured input when a required decision or missing information cannot be inferred.',
      'Use this for product choices, required preferences, or free-text details. Folder access uses the capability flow instead.',
      'Supports single-choice, multi-choice, and free-text questions. The result is keyed by stable question ids.',
    ].join(' '),
    parameters: ASK_USER_QUESTION_PARAMETERS,
    executionMode: 'sequential',
    execute: async (toolCallId, rawParams: unknown, signal?: AbortSignal) => {
      const normalized = normalizeAskUserQuestionRequest(rawParams);
      if (!normalized.ok) {
        return askUserQuestionError(normalized.code, normalized.message);
      }
      try {
        return askUserQuestionToolResult(await runtime.ask(toolCallId, normalized.request, signal));
      } catch (error) {
        return askUserQuestionError('QUESTION_CANCELLED', errorMessage(error));
      }
    },
  };
}

export function askUserQuestionToolResult(result: AskUserQuestionResult) {
  const envelope = successEnvelope(ASK_USER_QUESTION_TOOL_NAME, result, {
    instructions: result.outcome === 'discussed'
      ? 'The user wants to discuss before answering. Ask a short clarification question in normal conversation. If structured input is still required after discussion, call ask_user_question again.'
      : undefined,
  });
  return agentToolResult(envelope, result);
}

function askUserQuestionError(code: string, message: string) {
  return agentToolResult(errorEnvelope<AskUserQuestionResult>(ASK_USER_QUESTION_TOOL_NAME, code, message, {
    instructions: 'Revise the question request and try again only if the user input is still required.',
  }));
}

function normalizeAskUserQuestionRequest(raw: unknown):
  | { ok: true; request: AgentUserQuestionRequestView }
  | { ok: false; code: string; message: string } {
  if (!isRecord(raw)) return { ok: false, code: 'INVALID_INPUT', message: 'Input must be an object.' };
  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    return { ok: false, code: 'INVALID_QUESTIONS', message: 'Pass 1 to 4 questions.' };
  }

  const questions: AgentUserQuestionItemView[] = [];
  const seenQuestionIds = new Set<string>();
  const seenQuestionTexts = new Set<string>();
  for (const rawQuestion of rawQuestions) {
    const normalized = normalizeQuestion(rawQuestion);
    if (!normalized.ok) return normalized;
    const question = normalized.question;
    const questionTextKey = question.question.toLowerCase();
    if (seenQuestionIds.has(question.id)) {
      return { ok: false, code: 'DUPLICATE_QUESTION_ID', message: `Question id "${question.id}" is duplicated.` };
    }
    if (seenQuestionTexts.has(questionTextKey)) {
      return { ok: false, code: 'DUPLICATE_QUESTION_TEXT', message: `Question text "${question.question}" is duplicated.` };
    }
    seenQuestionIds.add(question.id);
    seenQuestionTexts.add(questionTextKey);
    questions.push(question);
  }

  return {
    ok: true,
    request: {
      questions,
      submitLabel: optionalTruncatedStringValue(raw.submit_label, 80),
    },
  };
}

function normalizeQuestion(raw: unknown):
  | { ok: true; question: AgentUserQuestionItemView }
  | { ok: false; code: string; message: string } {
  if (!isRecord(raw)) return { ok: false, code: 'INVALID_QUESTION', message: 'Each question must be an object.' };
  const id = truncatedStringValue(raw.id, 80);
  const type = raw.type;
  const question = truncatedStringValue(raw.question, 500);
  if (!id) return { ok: false, code: 'MISSING_QUESTION_ID', message: 'Each question needs an id.' };
  if (!isQuestionKind(type)) return { ok: false, code: 'INVALID_QUESTION_TYPE', message: `Invalid question type for "${id}".` };
  if (!question) return { ok: false, code: 'MISSING_QUESTION_TEXT', message: `Question "${id}" needs text.` };

  const options = normalizeOptions(raw.options);
  if (!options.ok) return options;
  if (type === 'free_text' && options.options.length > 0) {
    return { ok: false, code: 'FREE_TEXT_OPTIONS', message: `Free-text question "${id}" must not include options.` };
  }
  if (type !== 'free_text' && options.options.length < 2) {
    return { ok: false, code: 'CHOICE_OPTIONS', message: `Choice question "${id}" needs 2 to 6 options.` };
  }

  const allowReferences = booleanParam(raw.allow_references) ?? type === 'free_text';
  const allowAttachments = booleanParam(raw.allow_attachments) ?? type === 'free_text';
  return {
    ok: true,
    question: {
      id,
      type,
      header: optionalTruncatedStringValue(raw.header, 80),
      question,
      required: booleanParam(raw.required) ?? true,
      allowOther: type === 'free_text' ? false : booleanParam(raw.allow_other) ?? false,
      allowReferences,
      allowAttachments,
      options: options.options.length > 0 ? options.options : undefined,
    },
  };
}

function normalizeOptions(raw: unknown):
  | { ok: true; options: AgentUserQuestionOptionView[] }
  | { ok: false; code: string; message: string } {
  if (raw === undefined) return { ok: true, options: [] };
  if (!Array.isArray(raw) || raw.length > 6) {
    return { ok: false, code: 'INVALID_OPTIONS', message: 'Options must be an array with at most 6 items.' };
  }
  const options: AgentUserQuestionOptionView[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const rawOption of raw) {
    if (!isRecord(rawOption)) return { ok: false, code: 'INVALID_OPTION', message: 'Each option must be an object.' };
    const id = truncatedStringValue(rawOption.id, 80);
    const label = truncatedStringValue(rawOption.label, 120);
    if (!id || !label) return { ok: false, code: 'INVALID_OPTION', message: 'Each option needs id and label.' };
    const labelKey = label.toLowerCase();
    if (seenIds.has(id) || seenLabels.has(labelKey)) {
      return { ok: false, code: 'DUPLICATE_OPTION', message: `Option "${label}" is duplicated.` };
    }
    seenIds.add(id);
    seenLabels.add(labelKey);
    options.push({
      id,
      label,
      description: optionalTruncatedStringValue(rawOption.description, 300),
      recommended: booleanParam(rawOption.recommended),
    });
  }
  return { ok: true, options };
}

function isQuestionKind(value: unknown): value is AgentUserQuestionKind {
  return value === 'single_choice' || value === 'multi_choice' || value === 'free_text';
}

function booleanParam(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
