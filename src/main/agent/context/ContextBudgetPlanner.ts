import type { Api, Message, Model, Tool } from '../runtime/kernel/types';

const FALLBACK_CHARS_PER_TOKEN = 4;
const MESSAGE_FRAMING_TOKENS = 12;
const IMAGE_ESTIMATE_TOKENS = 2_048;
const PROVIDER_FRAMING_TOKENS = 512;
const MAX_OUTPUT_RESERVE_RATIO = 0.25;

export interface ContextBudgetPlan {
  readonly messages: readonly Message[];
  readonly estimatedInputTokens: number;
  readonly inputTokenLimit: number;
  readonly reservedOutputTokens: number;
}

export class ContextCapacityError extends Error {
  readonly code = 'AGENT_CONTEXT_CAPACITY';

  constructor(
    message: string,
    readonly requiredTokens: number,
    readonly availableTokens: number,
  ) {
    super(message);
    this.name = 'ContextCapacityError';
  }
}

export class ContextCompactionRequiredError extends Error {
  readonly code = 'AGENT_CONTEXT_COMPACTION_REQUIRED';

  constructor(
    readonly retainFromMessageIndex: number,
    readonly estimatedTokens: number,
    readonly availableTokens: number,
  ) {
    super(`Canonical history requires compaction (${estimatedTokens} estimated tokens, ${availableTokens} available).`);
    this.name = 'ContextCompactionRequiredError';
  }
}

export function planContextBudget(input: {
  readonly model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>;
  readonly systemPrompt: string;
  readonly tools: readonly Pick<Tool, 'name' | 'description' | 'parameters'>[];
  readonly messages: readonly Message[];
  /** First message belonging to the active Turn. */
  readonly protectedFromMessageIndex: number;
}): ContextBudgetPlan {
  const contextWindow = positiveLimit(input.model.contextWindow, 'model context window');
  const maxOutputTokens = positiveLimit(input.model.maxTokens, 'model output limit');
  const reservedOutputTokens = Math.min(
    maxOutputTokens,
    Math.max(1, Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO)),
  );
  const inputTokenLimit = contextWindow - reservedOutputTokens - PROVIDER_FRAMING_TOKENS;
  if (inputTokenLimit <= 0) {
    throw new ContextCapacityError(
      'The model context window cannot fit provider framing and reserved output.',
      PROVIDER_FRAMING_TOKENS + reservedOutputTokens,
      contextWindow,
    );
  }

  if (!Number.isInteger(input.protectedFromMessageIndex)
    || input.protectedFromMessageIndex < 0
    || input.protectedFromMessageIndex > input.messages.length) {
    throw new Error('protectedFromMessageIndex is outside the provider message list.');
  }

  const fixedTokens = estimateTextTokens(input.systemPrompt)
    + input.tools.reduce((total, tool) => total + estimateToolTokens(tool), 0);
  const units = contextMessageUnits(input.messages);
  const protectedUnitIndex = units.findIndex((unit) => unit.end > input.protectedFromMessageIndex);
  const firstProtectedUnit = protectedUnitIndex < 0 ? units.length : protectedUnitIndex;
  const requiredTokens = fixedTokens + units
    .slice(firstProtectedUnit)
    .reduce((total, unit) => total + unit.tokens, 0);

  if (requiredTokens > inputTokenLimit) {
    throw new ContextCapacityError(
      'The stable prompt, tools, and active Turn exceed the model input capacity.',
      requiredTokens,
      inputTokenLimit,
    );
  }

  const estimatedInputTokens = fixedTokens + units.reduce((total, unit) => total + unit.tokens, 0);
  if (estimatedInputTokens <= inputTokenLimit) {
    return {
      messages: input.messages,
      estimatedInputTokens,
      inputTokenLimit,
      reservedOutputTokens,
    };
  }

  let retainedTokens = requiredTokens;
  let retainFromMessageIndex = input.protectedFromMessageIndex;
  for (let index = firstProtectedUnit - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (retainedTokens + unit.tokens > inputTokenLimit) break;
    retainedTokens += unit.tokens;
    retainFromMessageIndex = unit.start;
  }
  throw new ContextCompactionRequiredError(
    retainFromMessageIndex,
    estimatedInputTokens,
    inputTokenLimit,
  );
}

export function estimateProviderMessageTokens(message: Message): number {
  let tokens = MESSAGE_FRAMING_TOKENS;
  if ('content' in message) {
    const content = typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content;
    for (const part of content) {
      if (part.type === 'text' || part.type === 'thinking') {
        tokens += estimateTextTokens('text' in part ? part.text : JSON.stringify(part));
      } else if (part.type === 'image') {
        tokens += IMAGE_ESTIMATE_TOKENS;
      } else if (part.type === 'toolCall') {
        tokens += estimateTextTokens(part.name) + estimateJsonTokens(part.arguments) + MESSAGE_FRAMING_TOKENS;
      }
    }
  }
  if (message.role === 'toolResult') {
    tokens += estimateTextTokens(message.toolCallId) + estimateTextTokens(message.toolName);
  }
  return tokens;
}

export function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / FALLBACK_CHARS_PER_TOKEN));
}

interface ContextMessageUnit {
  readonly start: number;
  readonly end: number;
  readonly tokens: number;
}

function contextMessageUnits(messages: readonly Message[]): ContextMessageUnit[] {
  const units: ContextMessageUnit[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === 'toolResult') {
      throw new Error(`Canonical provider history contains an orphaned tool result: ${message.toolCallId}`);
    }
    if (message.role !== 'assistant') {
      units.push(messageUnit(messages, index, index + 1));
      index += 1;
      continue;
    }
    const toolCallIds = message.content.flatMap((part) => part.type === 'toolCall' ? [part.id] : []);
    if (toolCallIds.length === 0) {
      units.push(messageUnit(messages, index, index + 1));
      index += 1;
      continue;
    }
    const expected = new Set(toolCallIds);
    let end = index + 1;
    while (end < messages.length && messages[end]!.role === 'toolResult') {
      const result = messages[end] as Extract<Message, { role: 'toolResult' }>;
      if (!expected.delete(result.toolCallId)) {
        throw new Error(`Canonical provider history contains an unexpected tool result: ${result.toolCallId}`);
      }
      end += 1;
    }
    if (expected.size > 0) {
      throw new Error(`Canonical provider history contains an incomplete tool exchange: ${[...expected].join(', ')}`);
    }
    units.push(messageUnit(messages, index, end));
    index = end;
  }
  return units;
}

function messageUnit(messages: readonly Message[], start: number, end: number): ContextMessageUnit {
  return {
    start,
    end,
    tokens: messages.slice(start, end).reduce((total, message) => total + estimateProviderMessageTokens(message), 0),
  };
}

function estimateToolTokens(tool: Pick<Tool, 'name' | 'description' | 'parameters'>): number {
  return MESSAGE_FRAMING_TOKENS
    + estimateTextTokens(tool.name)
    + estimateTextTokens(tool.description)
    + estimateJsonTokens(tool.parameters);
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return Math.floor(value);
}
