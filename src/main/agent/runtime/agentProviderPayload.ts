import type { Api, Model } from '@earendil-works/pi-ai';
import { applyCustomOpenAIResponsesPayloadProfile } from '../../openAIResponsesCompat';
import { applyAnthropicStablePromptCacheBreakpoints } from '../context/ProviderCache';
import type { StablePrompt } from '../context/stablePrompt';
import type { AgentTool } from './kernel/types';

export function agentProviderPayload(
  payload: unknown,
  model: Model<Api>,
  stablePrompt?: StablePrompt | null,
  tools: readonly AgentTool[] = [],
): unknown | undefined {
  const compatiblePayload = applyCustomOpenAIResponsesPayloadProfile(payload, model);
  const anthropicPayload = applyAnthropicAgentToolSchemaProfile(
    compatiblePayload ?? payload,
    model,
    tools,
  );
  const cachePayload = stablePrompt
    ? applyAnthropicStablePromptCacheBreakpoints(
        anthropicPayload ?? compatiblePayload ?? payload,
        model,
        stablePrompt,
      )
    : undefined;
  const source = cachePayload ?? anthropicPayload ?? compatiblePayload ?? payload;
  if (!isRecord(source) || !isOpenAIResponsesApi(model.api) || !isRecord(source.reasoning)) {
    return cachePayload ?? anthropicPayload ?? compatiblePayload;
  }
  if (source.reasoning.summary === 'detailed') {
    return cachePayload ?? anthropicPayload ?? compatiblePayload;
  }
  return {
    ...source,
    reasoning: {
      ...source.reasoning,
      summary: 'detailed',
    },
  };
}

function applyAnthropicAgentToolSchemaProfile(
  payload: unknown,
  model: Model<Api>,
  tools: readonly AgentTool[],
): unknown | undefined {
  if (model.api !== 'anthropic-messages' || !isRecord(payload) || !Array.isArray(payload.tools)) {
    return undefined;
  }
  const schemas = new Map(tools
    .filter((tool) => isAgentTaskToolName(tool.name))
    .map((tool) => [tool.name, tool.parameters] as const));
  if (schemas.size === 0) return undefined;

  let changed = false;
  const providerTools = payload.tools.map((value) => {
    if (!isRecord(value) || typeof value.name !== 'string') return value;
    const schema = schemas.get(value.name);
    if (!schema) return value;
    changed = true;
    const { name, description, input_schema: _inputSchema, ...rest } = value;
    return {
      name,
      description,
      input_schema: schema,
      ...rest,
    };
  });
  return changed ? { ...payload, tools: providerTools } : undefined;
}

function isOpenAIResponsesApi(api: Api): boolean {
  return api === 'openai-responses'
    || api === 'openai-codex-responses'
    || api === 'azure-openai-responses';
}

function isAgentTaskToolName(value: string): value is 'task_status' | 'task_stop' {
  return value === 'task_status' || value === 'task_stop';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
