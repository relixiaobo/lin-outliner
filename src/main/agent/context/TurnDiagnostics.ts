import { createHash } from 'node:crypto';
import type { AgentEvent, AgentState } from '@earendil-works/pi-agent-core';
import type {
  Api,
  Context,
  Message,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  Tool,
} from '@earendil-works/pi-ai';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type {
  JsonValue,
  TurnDiagnosticsPayload,
  TurnDiagnosticsProviderCall,
  TurnDiagnosticsMessagePartProvenance,
  TurnDiagnosticsProviderRequest,
  TurnDiagnosticsProviderRequestField,
} from '../../../core/agent/protocol';
import type { ContextBudgetPlan } from './ContextBudgetPlanner';
import { estimateProviderMessageTokens } from './ContextBudgetPlanner';
import type { StablePrompt } from './stablePrompt';

interface PreparedProviderPlan {
  readonly protectedFromMessageIndex: number;
  readonly budget: ContextBudgetPlan;
  readonly messagePartProvenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[];
}

interface TurnDiagnosticsCollectorInput {
  readonly contextEpochId: string;
  readonly cacheAffinity: string;
  readonly configuration: EffectiveThreadConfiguration;
  readonly stablePrompt: StablePrompt | null;
  readonly tools: readonly Tool[];
  readonly model: Model<Api>;
  readonly thinkingLevel: AgentState['thinkingLevel'];
  readonly providerOptions: Pick<
    SimpleStreamOptions,
    'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'cacheRetention'
  >;
}

interface MutableProviderCall extends Omit<
  TurnDiagnosticsProviderCall,
  'executionItemIds' | 'response' | 'transportResponse'
> {
  executionItemIds: string[];
  transportResponse: TurnDiagnosticsProviderCall['transportResponse'];
  response: TurnDiagnosticsProviderCall['response'];
}

export class TurnDiagnosticsCollector {
  private readonly canonicalMessages = new Map<string, TurnDiagnosticsPayload['canonicalMessages'][number]>();
  private readonly requestFragments = new Map<string, TurnDiagnosticsPayload['requestFragments'][number]>();
  private readonly providerCalls: MutableProviderCall[] = [];
  private preparedPlan: PreparedProviderPlan | null = null;
  private providerContext: Context | null = null;

  constructor(private readonly input: TurnDiagnosticsCollectorInput) {}

  prepareProviderPlan(plan: PreparedProviderPlan): void {
    this.preparedPlan = plan;
  }

  captureProviderContext(context: Context): void {
    this.providerContext = context;
  }

  captureProviderRequest(payload: unknown): void {
    if (!this.preparedPlan) throw new Error('Provider request diagnostics are missing the prepared context plan.');
    if (!this.providerContext) throw new Error('Provider request diagnostics are missing the provider context.');
    const messageIds = this.providerContext.messages.map((message) => this.rememberMessage(message));
    assertMessageProvenance(this.providerContext.messages, this.preparedPlan.messagePartProvenance);
    const previous = this.providerCalls.at(-1)?.preparedContext.messageIds ?? [];
    const normalizedRequest = jsonValue(payload, true);
    this.providerCalls.push({
      index: this.providerCalls.length,
      requestedAt: Date.now(),
      preparedContext: {
        systemPromptFragmentId: this.rememberRequestFragment(jsonValue(this.providerContext.systemPrompt, true)),
        toolNames: (this.providerContext.tools ?? []).map((tool) => tool.name),
        messageIds,
        messagePartProvenance: this.preparedPlan.messagePartProvenance.map((parts) => parts.map((part) => ({ ...part }))),
      },
      protectedFromMessageIndex: this.preparedPlan.protectedFromMessageIndex,
      estimatedInputTokens: this.preparedPlan.budget.estimatedInputTokens,
      inputTokenLimit: this.preparedPlan.budget.inputTokenLimit,
      reservedOutputTokens: this.preparedPlan.budget.reservedOutputTokens,
      commonPrefixMessageCount: commonPrefixLength(previous, messageIds),
      request: this.rememberProviderRequest(normalizedRequest),
      requestFingerprint: fingerprint(stableJson(normalizedRequest)),
      cacheBreakpoints: cacheBreakpointPaths(payload),
      executionItemIds: [],
      transportResponse: null,
      response: null,
    });
  }

  captureExecutionItem(itemId: string): void {
    const call = this.providerCalls.at(-1);
    if (!call) return;
    if (!call.executionItemIds.includes(itemId)) call.executionItemIds.push(itemId);
  }

  captureTransportResponse(response: ProviderResponse): void {
    const call = [...this.providerCalls].reverse().find((candidate) => candidate.transportResponse === null);
    if (!call) return;
    call.transportResponse = {
      headersReceivedAt: Date.now(),
      httpStatus: response.status,
      requestId: providerRequestId(response.headers),
    };
  }

  captureEvent(event: AgentEvent): void {
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    const call = [...this.providerCalls].reverse().find((candidate) => candidate.response === null);
    if (!call) return;
    call.response = {
      receivedAt: Date.now(),
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage ?? null,
      usage: {
        input: event.message.usage.input,
        output: event.message.usage.output,
        cacheRead: event.message.usage.cacheRead,
        cacheWrite: event.message.usage.cacheWrite,
        cacheWrite1h: event.message.usage.cacheWrite1h ?? null,
        reasoning: event.message.usage.reasoning ?? null,
        totalTokens: event.message.usage.totalTokens,
        cost: { ...event.message.usage.cost },
      },
      value: jsonValue(event.message, true),
    };
  }

  payload(): TurnDiagnosticsPayload {
    const { configuration, model, providerOptions, stablePrompt, thinkingLevel, tools } = this.input;
    return {
      schemaVersion: 1,
      contextEpochId: this.input.contextEpochId,
      cacheAffinity: this.input.cacheAffinity,
      configuration: {
        profileName: configuration.profileName,
        developerInstructions: [...configuration.developerInstructions],
        model: configuration.model,
        reasoningEffort: configuration.reasoningEffort,
        tools: [...configuration.tools],
        skills: [...configuration.skills],
        plugins: [...configuration.plugins],
        mcpServers: [...configuration.mcpServers],
      },
      stablePrompt: stablePrompt ? {
        blocks: stablePrompt.blocks.map((block) => ({ ...block })),
        fingerprints: { ...stablePrompt.fingerprints },
      } : null,
      toolSchemas: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonValue(tool.parameters, true),
      })),
      runtime: {
        provider: model.provider,
        model: model.id,
        api: model.api,
        configuredBaseUrl: diagnosticBaseUrl(model.baseUrl),
        transportSelection: 'auto',
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        thinkingLevel,
        timeoutMs: providerOptions.timeoutMs ?? null,
        maxRetries: providerOptions.maxRetries ?? null,
        maxRetryDelayMs: providerOptions.maxRetryDelayMs ?? null,
        cacheRetention: providerOptions.cacheRetention ?? 'none',
        toolExecution: 'parallel',
        steeringMode: 'all',
      },
      canonicalMessages: [...this.canonicalMessages.values()],
      requestFragments: [...this.requestFragments.values()],
      providerCalls: this.providerCalls.map((call) => ({ ...call })),
    };
  }

  private rememberMessage(message: Message): string {
    const value = jsonValue(message, true);
    const id = fingerprint(stableJson(value));
    if (!this.canonicalMessages.has(id)) {
      this.canonicalMessages.set(id, {
        id,
        estimatedTokens: estimateProviderMessageTokens(message),
        value,
      });
    }
    return id;
  }

  private rememberProviderRequest(value: JsonValue): TurnDiagnosticsProviderRequest {
    if (!isRecord(value)) return { kind: 'value', value };
    const fields: TurnDiagnosticsProviderRequestField[] = [];
    for (const [name, fieldValue] of Object.entries(value)) {
      if (!PROVIDER_REQUEST_FRAGMENT_FIELDS.has(name)) {
        fields.push({ name, representation: 'inline', value: fieldValue as JsonValue });
        continue;
      }
      const values = Array.isArray(fieldValue) ? fieldValue : [fieldValue as JsonValue];
      fields.push({
        name,
        representation: 'fragments',
        container: Array.isArray(fieldValue) ? 'array' : 'value',
        fragmentIds: values.map((entry) => this.rememberRequestFragment(entry as JsonValue)),
      });
    }
    return { kind: 'object', fields };
  }

  private rememberRequestFragment(value: JsonValue): string {
    const id = fingerprint(stableJson(value));
    if (!this.requestFragments.has(id)) this.requestFragments.set(id, { id, value });
    return id;
  }
}

function assertMessageProvenance(
  messages: readonly Message[],
  provenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[],
): void {
  if (messages.length !== provenance.length) {
    throw new Error('Provider request diagnostics message provenance is not aligned with the provider context.');
  }
  messages.forEach((message, index) => {
    const content = 'content' in message
      ? typeof message.content === 'string' ? [message.content] : message.content
      : [];
    if (content.length !== provenance[index]?.length) {
      throw new Error(`Provider request diagnostics content provenance is not aligned with message ${index}.`);
    }
  });
}

const PROVIDER_REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-ms-request-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-goog-request-id',
] as const;

function providerRequestId(headers: Readonly<Record<string, string>>): string | null {
  const normalized = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  for (const name of PROVIDER_REQUEST_ID_HEADERS) {
    const value = normalized.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function diagnosticBaseUrl(value: string): string {
  if (!value) return '';
  try {
    const endpoint = new URL(value);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return '';
  }
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function cacheBreakpointPaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (entry: unknown, path: string) => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(entry)) return;
    if ('cache_control' in entry) paths.push(`${path}.cache_control`);
    for (const [key, child] of Object.entries(entry)) visit(child, `${path}.${key}`);
  };
  visit(value, '$');
  return paths;
}

const PROVIDER_REQUEST_FRAGMENT_FIELDS = new Set([
  'contents',
  'input',
  'instructions',
  'messages',
  'prompt',
  'system',
  'systemPrompt',
  'tools',
]);

function jsonValue(value: unknown, omitImageBytes: boolean): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return omitImageBytes && value.startsWith('data:image/')
      ? imageDataUrlMarker(value)
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, omitImageBytes));
  if (value instanceof Uint8Array) return binaryMarker(value);
  if (!isRecord(value)) return String(value);
  const result: Record<string, JsonValue> = {};
  const imageData = omitImageBytes && value.type === 'image' && typeof value.data === 'string'
    ? value.data
    : null;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (imageData !== null && key === 'data') {
      result.data = base64Marker(imageData);
    } else {
      result[key] = jsonValue(entry, omitImageBytes);
    }
  }
  return result;
}

function binaryMarker(value: Uint8Array): JsonValue {
  return {
    omitted: true,
    encoding: 'binary',
    byteLength: value.byteLength,
    sha256: createHash('sha256').update(value).digest('hex'),
  };
}

function base64Marker(value: string): JsonValue {
  const bytes = Buffer.from(value, 'base64');
  return {
    omitted: true,
    encoding: 'base64',
    encodedLength: value.length,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function imageDataUrlMarker(value: string): JsonValue {
  const separator = value.indexOf(',');
  if (separator < 0 || !value.slice(0, separator).endsWith(';base64')) {
    return { omitted: true, encoding: 'data-url', encodedLength: value.length };
  }
  const header = value.slice(5, separator);
  return {
    ...base64Marker(value.slice(separator + 1)) as Record<string, JsonValue>,
    encoding: 'data-url',
    mimeType: header.slice(0, -';base64'.length),
  };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key]!)}`
  )).join(',')}}`;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
