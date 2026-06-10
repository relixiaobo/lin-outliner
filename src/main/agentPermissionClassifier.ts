import {
  completeSimple,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TextContent as PiTextContent,
  type Tool,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '../core/agentTypes';
import type { AgentRuntimeSettings } from '../core/types';
import { assistantMessageText } from './agentCompaction';
import { awaitWithAbort } from './agentAwaitWithAbort';
import {
  getProviderApiKey,
  providerStreamOptionsFromRuntimeSettings,
  type AgentProviderRuntimeConfig,
} from './agentSettings';
import { toPermissionClassifierInput, type AgentPermissionClassifierProjection } from './agentPermissions';
import type { AgentPermissionClassifier } from './agentPermissionAskResolver';
import {
  PERMISSION_CLASSIFIER_SYSTEM_PROMPT,
  PERMISSION_CLASSIFIER_TOOL_NAME,
  buildPermissionClassifierTranscript,
  parsePermissionClassifierResponse,
} from './agentPermissionClassifierPrompt';

export type CompleteSimpleFn = typeof completeSimple;

const PERMISSION_CLASSIFIER_TOOL = {
  name: PERMISSION_CLASSIFIER_TOOL_NAME,
  description: 'Return the binary permission classifier result for the pending tool action.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      outcome: { type: 'string', enum: ['allow', 'block'] },
      reason: { type: 'string' },
    },
    required: ['outcome', 'reason'],
  },
} as unknown as Tool;

export function createDefaultPermissionClassifier(options: {
  conversationId: string;
  model: () => Model<Api>;
  providerConfig: AgentProviderRuntimeConfig;
  providerApiKeyLoader?: (providerId: string) => Promise<string | undefined> | string | undefined;
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>;
  completeSimpleFn?: CompleteSimpleFn;
}): AgentPermissionClassifier {
  return async (input, signal) => {
    const model = options.model();
    const transcript = buildPermissionClassifierTranscript(input.contextRecords ?? [{
      pending_tool_use: {
        tool: input.projection.tool,
        input: input.projection.input,
      },
    }]);
    if (!transcript) {
      return permissionClassifierUnavailable(model.id, 'Permission classifier transcript is too long.');
    }

    try {
      const runtimeSettings = await loadRuntimeSettingsForPermissionClassifier(options.runtimeSettingsLoader);
      const apiKey = options.providerConfig.apiKey
        ?? await options.providerApiKeyLoader?.(options.providerConfig.providerId)
        ?? await getProviderApiKey(options.providerConfig.providerId);
      const response = await awaitWithAbort((options.completeSimpleFn ?? completeSimple)(model, {
        systemPrompt: PERMISSION_CLASSIFIER_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Classifier transcript:\n${transcript}`,
          timestamp: Date.now(),
        }],
        tools: [PERMISSION_CLASSIFIER_TOOL],
      }, {
        ...providerStreamOptionsFromRuntimeSettings(runtimeSettings),
        apiKey,
        maxTokens: Math.min(model.maxTokens ?? 256, 256),
        // pi-ai stream option (provider cache affinity) — the lib's own field name.
        sessionId: options.conversationId,
        signal,
        temperature: 0,
        toolChoice: permissionClassifierToolChoice(model),
      } as SimpleStreamOptions & { toolChoice?: unknown }), { signal });
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        return permissionClassifierUnavailable(model.id, response.errorMessage || 'Permission classifier failed.');
      }
      const parsed = parsePermissionClassifierAssistantMessage(response);
      return parsed
        ? { ...parsed, model: model.id }
        : permissionClassifierUnavailable(model.id, 'Permission classifier returned malformed output.');
    } catch (error) {
      return permissionClassifierUnavailable(model.id, error instanceof Error ? error.message : String(error));
    }
  };
}

export function buildPermissionClassifierContextRecords(
  messages: readonly AgentMessage[],
  currentProjection: AgentPermissionClassifierProjection,
): unknown[] {
  const records: unknown[] = [];
  for (const message of messages.slice(-16)) {
    if (message.role === 'user') {
      const text = messageTextContent(message).trim();
      if (text) records.push({ user: text.slice(0, 4000) });
    } else if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        const projection = toPermissionClassifierInput(part.name, part.arguments);
        records.push({
          tool_use: {
            tool: projection?.tool ?? part.name,
            input: projection?.input ?? {},
          },
        });
      }
    }
  }
  records.push({
    pending_tool_use: {
      tool: currentProjection.tool,
      input: currentProjection.input,
    },
  });
  return records;
}

function parsePermissionClassifierAssistantMessage(message: AssistantMessage): { outcome: 'allow' | 'block'; reason: string } | null {
  const toolCall = message.content.find((part): part is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> => (
    part.type === 'toolCall' && part.name === PERMISSION_CLASSIFIER_TOOL_NAME
  ));
  if (toolCall && typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
    const args = toolCall.arguments as { outcome?: unknown; reason?: unknown };
    if (args.outcome === 'allow' || args.outcome === 'block') {
      return {
        outcome: args.outcome,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'No classifier reason provided.',
      };
    }
  }
  return parsePermissionClassifierResponse(assistantMessageText(message));
}

function permissionClassifierUnavailable(model: string, reason: string) {
  return {
    outcome: 'block' as const,
    reason,
    model,
    unavailable: true,
  };
}

async function loadRuntimeSettingsForPermissionClassifier(
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>,
): Promise<AgentRuntimeSettings | undefined> {
  try {
    return await runtimeSettingsLoader?.();
  } catch {
    return undefined;
  }
}

function messageTextContent(message: Extract<AgentMessage, { role: 'user' }>): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is PiTextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function permissionClassifierToolChoice(model: Model<Api>): unknown {
  switch (model.api) {
    case 'anthropic-messages':
    case 'bedrock-converse-stream':
      return { type: 'tool', name: PERMISSION_CLASSIFIER_TOOL_NAME };
    case 'openai-completions':
    case 'mistral-conversations':
      return { type: 'function', function: { name: PERMISSION_CLASSIFIER_TOOL_NAME } };
    case 'google-generative-ai':
    case 'google-vertex':
      return 'any';
    default:
      return 'required';
  }
}
