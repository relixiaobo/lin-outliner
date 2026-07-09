import type { Api, Model } from '@earendil-works/pi-ai';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import { parseCcSwitchModelOptionId } from './ccSwitchRegistry';

type ResponsesCompatModel = Pick<Model<Api>, 'api' | 'baseUrl'> & Partial<Pick<Model<Api>, 'id'>>;

export function isCustomOpenAIResponsesEndpoint(model?: ResponsesCompatModel | null): boolean {
  return model?.api === 'openai-responses'
    && Boolean(model.baseUrl)
    && !isOfficialOpenAIBaseUrl(model.baseUrl);
}

export function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return baseUrl.includes('api.openai.com');
  }
}

export function applyCustomOpenAIResponsesPayloadProfile(
  payload: unknown,
  model: ResponsesCompatModel,
): unknown | undefined {
  if (!isRecord(payload)) return undefined;

  const nextPayload: Record<string, unknown> = { ...payload };
  let changed = applyCcSwitchModelAlias(nextPayload, model);

  if (!isCustomOpenAIResponsesEndpoint(model)) return changed ? nextPayload : undefined;
  if (!Array.isArray(payload.input)) return changed ? nextPayload : undefined;

  const input = [...payload.input];
  const instructions = extractLeadingInstructions(input);
  changed = instructions.changed || changed;

  if (instructions.text) {
    nextPayload.input = instructions.input;
    nextPayload.instructions = combineInstructions(nextPayload.instructions, instructions.text);
    changed = true;
  }

  if (!hasLowVerbosity(nextPayload.text)) {
    nextPayload.text = { ...(isRecord(nextPayload.text) ? nextPayload.text : {}), verbosity: 'low' };
    changed = true;
  }

  if (Array.isArray(nextPayload.tools) && nextPayload.tools.length > 0) {
    if (nextPayload.tool_choice === undefined) {
      nextPayload.tool_choice = 'auto';
      changed = true;
    }
    if (nextPayload.parallel_tool_calls === undefined) {
      nextPayload.parallel_tool_calls = true;
      changed = true;
    }
  }

  return changed ? nextPayload : undefined;
}

export function customOpenAIResponsesPayloadProfileOption(): Pick<SimpleStreamOptions, 'onPayload'> {
  return {
    onPayload: async (payload, model) => applyCustomOpenAIResponsesPayloadProfile(payload, model),
  };
}

function extractLeadingInstructions(input: unknown[]): { input: unknown[]; text: string; changed: boolean } {
  const parts: string[] = [];
  let index = 0;
  while (index < input.length) {
    const item = input[index];
    if (!isRecord(item)) break;
    const role = item.role;
    if (role !== 'system' && role !== 'developer') break;
    const text = instructionText(item.content);
    if (!text) break;
    parts.push(text);
    index += 1;
  }
  if (index === 0) return { input, text: '', changed: false };
  return { input: input.slice(index), text: parts.join('\n\n'), changed: true };
}

function instructionText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const text = content
    .flatMap((part): string[] => (
      isRecord(part) && typeof part.text === 'string' ? [part.text] : []
    ))
    .join('\n')
    .trim();
  return text;
}

function combineInstructions(current: unknown, extracted: string): string {
  const existing = typeof current === 'string' ? current.trim() : '';
  if (!existing) return extracted;
  if (!extracted) return existing;
  return `${existing}\n\n${extracted}`;
}

function hasLowVerbosity(value: unknown): boolean {
  return isRecord(value) && value.verbosity === 'low';
}

function applyCcSwitchModelAlias(payload: Record<string, unknown>, model: ResponsesCompatModel): boolean {
  const modelId = typeof model.id === 'string' ? model.id : undefined;
  const upstreamModel = modelId ? parseCcSwitchModelOptionId(modelId)?.modelId : undefined;
  if (!upstreamModel || payload.model !== modelId) return false;
  payload.model = upstreamModel;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
