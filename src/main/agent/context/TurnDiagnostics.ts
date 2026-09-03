import { createHash } from 'node:crypto';
import type {
  AgentEvent,
  AgentState,
  Api,
  Context,
  Message,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  Tool,
} from '../runtime/kernel/types';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import {
  MAX_TURN_DIAGNOSTICS_STREAM_NOISE_FRAMES,
  type JsonValue,
  type ModelToolCallHistory,
  type ThreadItem,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsActivity,
  type TurnDiagnosticsProviderCall,
  type TurnDiagnosticsMessagePartProvenance,
  type TurnDiagnosticsProviderRequest,
  type TurnDiagnosticsProviderRequestField,
} from '../../../core/agent/protocol';
import {
  redactSecretLikeJsonForDiagnostics,
} from '../capabilities/agentSecretRedaction';
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
  readonly initialInput: {
    readonly acceptedAt: number;
    readonly itemIds: readonly string[];
  };
}

interface MutableProviderCall extends Omit<
  TurnDiagnosticsProviderCall,
  'response' | 'streamNoiseFrames' | 'transportResponse'
> {
  streamNoiseFrames: NonNullable<TurnDiagnosticsProviderCall['streamNoiseFrames']>[number][];
  transportResponse: TurnDiagnosticsProviderCall['transportResponse'];
  response: TurnDiagnosticsProviderCall['response'];
}

type MutableAcceptedInputActivity = Omit<
  Extract<TurnDiagnosticsActivity, { type: 'acceptedInput' }>,
  'consumedByCallIndex'
> & {
  consumedByCallIndex: number | null;
  delivered: boolean;
};
type MutableToolExecution = {
  callId: string;
  toolName: string;
  itemId: string | null;
  admissionDisposition: ModelToolCallHistory['disposition'];
  canonicalIdentity: ModelToolCallHistory['identity'];
  schemaDigest: string | null;
  startedAt: number;
  completedAt: number | null;
  status: Extract<TurnDiagnosticsActivity, { type: 'toolExecutionBatch' }>['executions'][number]['status'];
};
type MutableToolExecutionBatchActivity = Omit<
  Extract<TurnDiagnosticsActivity, { type: 'toolExecutionBatch' }>,
  'consumedByCallIndex' | 'executions'
> & {
  consumedByCallIndex: number | null;
  executions: MutableToolExecution[];
};
type MutableProviderRetryActivity = Omit<
  Extract<TurnDiagnosticsActivity, { type: 'providerRetry' }>,
  'nextCallIndex'
> & {
  nextCallIndex: number | null;
};
type MutableContextCompactionActivity = Omit<
  Extract<TurnDiagnosticsActivity, { type: 'contextCompaction' }>,
  'nextCallIndex'
> & {
  nextCallIndex: number | null;
};
type MutableActivity =
  | MutableAcceptedInputActivity
  | Extract<TurnDiagnosticsActivity, { type: 'modelCall' }>
  | MutableToolExecutionBatchActivity
  | MutableProviderRetryActivity
  | MutableContextCompactionActivity;

export class TurnDiagnosticsCollector {
  private readonly canonicalMessages = new Map<string, TurnDiagnosticsPayload['canonicalMessages'][number]>();
  private readonly requestFragments = new Map<string, TurnDiagnosticsPayload['requestFragments'][number]>();
  private readonly providerCalls: MutableProviderCall[] = [];
  private readonly activities: MutableActivity[] = [];
  private preparedPlan: PreparedProviderPlan | null = null;
  private providerContext: Context | null = null;
  private disabled = false;

  constructor(private readonly input: TurnDiagnosticsCollectorInput) {
    this.activities.push({
      type: 'acceptedInput',
      source: 'initial',
      acceptedAt: input.initialInput.acceptedAt,
      itemIds: [...input.initialInput.itemIds],
      consumedByCallIndex: null,
      delivered: true,
    });
  }

  get available(): boolean {
    return !this.disabled;
  }

  disable(): void {
    this.disabled = true;
  }

  prepareProviderPlan(plan: PreparedProviderPlan): void {
    this.preparedPlan = plan;
  }

  captureProviderContext(context: Context): void {
    this.providerContext = context;
  }

  async captureProviderRequest(payload: unknown): Promise<void> {
    if (!this.preparedPlan) throw new Error('Provider request diagnostics are missing the prepared context plan.');
    if (!this.providerContext) throw new Error('Provider request diagnostics are missing the provider context.');
    assertMessageProvenance(this.providerContext.messages, this.preparedPlan.messagePartProvenance);
    const previous = this.providerCalls.at(-1)?.preparedContext.messageIds ?? [];
    const normalizedRequest = jsonValue(payload, true);
    const diagnostic = await redactSecretLikeJsonForDiagnostics({
      messages: this.providerContext.messages.map((message) => jsonValue(message, true)),
      request: normalizedRequest,
    });
    const diagnosticOmitted = typeof diagnostic.value === 'string';
    const diagnosticMessages = diagnosticOmitted ? [] : diagnostic.value.messages;
    const messageIds = this.providerContext.messages.map((message, messageIndex) => this.rememberMessage(
      message,
      diagnosticMessages[messageIndex] ?? '[diagnostic message omitted]',
    ));
    const redactedRequest = diagnosticOmitted ? diagnostic.value : diagnostic.value.request;
    const index = this.providerCalls.length;
    this.bindPendingActivities(index);
    this.providerCalls.push({
      index,
      requestedAt: Date.now(),
      preparedContext: {
        systemPromptFragmentId: this.rememberRequestFragment(jsonValue(this.providerContext.systemPrompt, true)),
        toolNames: (this.providerContext.tools ?? []).map((tool) => tool.name),
        messageIds,
        messagePartProvenance: this.preparedPlan.messagePartProvenance.map((parts) => (
          parts.map(clonePartProvenance)
        )),
      },
      protectedFromMessageIndex: this.preparedPlan.protectedFromMessageIndex,
      estimatedInputTokens: this.preparedPlan.budget.estimatedInputTokens,
      inputTokenLimit: this.preparedPlan.budget.inputTokenLimit,
      reservedOutputTokens: this.preparedPlan.budget.reservedOutputTokens,
      commonPrefixMessageCount: commonPrefixLength(previous, messageIds),
      request: this.rememberProviderRequest(
        redactedRequest,
        this.providerContext.messages,
        this.preparedPlan.messagePartProvenance,
      ),
      requestFingerprint: fingerprint(stableJson(normalizedRequest)),
      cacheBreakpoints: cacheBreakpointPaths(payload),
      streamNoiseFrames: [],
      transportResponse: null,
      response: null,
    });
    this.activities.push({ type: 'modelCall', callIndex: index });
  }

  captureToolExecutionStarted(
    callId: string,
    toolName: string,
    itemId: string | null,
    modelCall: ModelToolCallHistory,
    startedAt = Date.now(),
  ): void {
    const sourceCall = this.providerCalls.at(-1);
    if (!sourceCall) return;
    const batch = [...this.activities].reverse().find((activity): activity is MutableToolExecutionBatchActivity => (
      activity.type === 'toolExecutionBatch'
      && activity.sourceCallIndex === sourceCall.index
      && activity.consumedByCallIndex === null
    )) ?? null;
    const target = batch ?? {
      type: 'toolExecutionBatch' as const,
      sourceCallIndex: sourceCall.index,
      consumedByCallIndex: null,
      executions: [],
    };
    if (!batch) this.activities.push(target);
    if (target.executions.some((execution) => execution.callId === callId)) return;
    target.executions.push({
      callId,
      toolName,
      itemId,
      admissionDisposition: modelCall.disposition,
      canonicalIdentity: modelCall.identity,
      schemaDigest: modelCall.disposition === 'evidenceOnly' ? null : modelCall.schemaDigest,
      startedAt,
      completedAt: null,
      status: 'inProgress',
    });
  }

  captureToolExecutionCompleted(callId: string, failed: boolean, completedAt = Date.now()): void {
    for (let index = this.activities.length - 1; index >= 0; index -= 1) {
      const activity = this.activities[index];
      if (activity?.type !== 'toolExecutionBatch') continue;
      const execution = activity.executions.find((candidate) => candidate.callId === callId);
      if (!execution || execution.completedAt !== null) continue;
      execution.completedAt = Math.max(execution.startedAt, completedAt);
      execution.status = failed ? 'failed' : 'completed';
      return;
    }
  }

  captureProviderRetry(
    event: { readonly kind: 'request' | 'stream'; readonly attempt: number; readonly maxRetries: number },
    occurredAt = Date.now(),
  ): void {
    const sourceCall = this.providerCalls.at(-1);
    if (!sourceCall) return;
    this.activities.push({
      type: 'providerRetry',
      retryKind: event.kind,
      attempt: event.attempt,
      maxRetries: event.maxRetries,
      occurredAt,
      sourceCallIndex: sourceCall.index,
      nextCallIndex: null,
    });
  }

  captureStreamNoiseFrame(frame: {
    readonly arrivedAt: number;
    readonly frameType: string | null;
    readonly snippet: string;
  }): void {
    const sourceCall = this.providerCalls.at(-1);
    if (!sourceCall) return;
    if (sourceCall.streamNoiseFrames.length >= MAX_TURN_DIAGNOSTICS_STREAM_NOISE_FRAMES) return;
    sourceCall.streamNoiseFrames.push({
      arrivedAt: Number.isFinite(frame.arrivedAt)
        ? Math.max(sourceCall.requestedAt, frame.arrivedAt)
        : sourceCall.requestedAt,
      frameType: frame.frameType?.trim() ? frame.frameType : null,
      snippet: frame.snippet,
    });
  }

  captureContextCompaction(item: Extract<ThreadItem, { type: 'contextCompaction' }>, completedAt = Date.now()): void {
    if (item.trigger === 'manual') return;
    this.activities.push({
      type: 'contextCompaction',
      trigger: item.trigger,
      itemId: item.id,
      completedAt,
      sourceCallIndex: this.providerCalls.at(-1)?.index ?? null,
      nextCallIndex: null,
    });
  }

  captureSteering(items: readonly ThreadItem[], acceptedAt: number): number {
    this.activities.push({
      type: 'acceptedInput',
      source: 'steering',
      acceptedAt,
      itemIds: items.map((item) => item.id),
      consumedByCallIndex: null,
      delivered: false,
    });
    return this.activities.length - 1;
  }

  setSteeringDelivered(activityIndex: number, delivered: boolean): void {
    const activity = this.activities[activityIndex];
    if (activity?.type !== 'acceptedInput' || activity.source !== 'steering') {
      throw new Error('Steering diagnostics activity is no longer reachable.');
    }
    activity.delivered = delivered;
  }

  finalizeOpenToolExecutions(status: 'completed' | 'failed' | 'interrupted', completedAt = Date.now()): void {
    for (const activity of this.activities) {
      if (activity.type !== 'toolExecutionBatch') continue;
      for (const execution of activity.executions) {
        if (execution.completedAt !== null) continue;
        execution.completedAt = Math.max(execution.startedAt, completedAt);
        execution.status = status;
      }
    }
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

  async captureEvent(event: AgentEvent): Promise<void> {
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    // pi-ai uses `pending` and `deferred` only for non-terminal request states.
    // Diagnostics are inspection-only, so an unexpected non-terminal
    // message_end stays unrecorded instead of widening the durable terminal-response
    // contract or killing a Turn.
    if (event.message.stopReason === 'pending' || event.message.stopReason === 'deferred') return;
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
      value: (await redactSecretLikeJsonForDiagnostics(jsonValue(event.message, true))).value,
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
      providerCalls: this.providerCalls.map((call) => ({
        ...call,
        streamNoiseFrames: call.streamNoiseFrames.map((frame) => ({ ...frame })),
      })),
      activities: this.activities.map((activity) => (
        activity.type === 'acceptedInput'
          ? acceptedInputActivity(activity)
          : activity.type === 'toolExecutionBatch'
            ? { ...activity, executions: activity.executions.map((execution) => ({ ...execution })) }
            : { ...activity }
      )),
    };
  }

  private bindPendingActivities(callIndex: number): void {
    for (const activity of this.activities) {
      if (activity.type === 'acceptedInput' && activity.delivered && activity.consumedByCallIndex === null) {
        activity.consumedByCallIndex = callIndex;
      } else if (activity.type === 'toolExecutionBatch' && activity.consumedByCallIndex === null) {
        activity.consumedByCallIndex = callIndex;
      } else if (activity.type === 'providerRetry' && activity.nextCallIndex === null) {
        activity.nextCallIndex = callIndex;
      } else if (activity.type === 'contextCompaction' && activity.nextCallIndex === null) {
        activity.nextCallIndex = callIndex;
      }
    }
  }

  private rememberMessage(message: Message, value: JsonValue): string {
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

  private rememberProviderRequest(
    value: JsonValue,
    messages: readonly Message[],
    provenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[],
  ): TurnDiagnosticsProviderRequest {
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
        fragmentPartProvenance: values.map((entry) => (
          exactProviderFragmentProvenance(entry as JsonValue, messages, provenance)
        )),
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

function acceptedInputActivity(
  activity: MutableAcceptedInputActivity,
): Extract<TurnDiagnosticsActivity, { type: 'acceptedInput' }> {
  const { delivered: _delivered, ...stored } = activity;
  return stored;
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

function exactProviderFragmentProvenance(
  fragment: JsonValue,
  messages: readonly Message[],
  provenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[],
): readonly TurnDiagnosticsMessagePartProvenance[] | null {
  const fragmentParts = diagnosticContentParts(fragment);
  if (fragmentParts.length === 0) return null;
  const matches = messages.flatMap((message, messageIndex) => {
    const messageParts = diagnosticContentParts(jsonValue(message, true));
    const messageProvenance = provenance[messageIndex];
    if (
      !messageProvenance
      || messageParts.length !== fragmentParts.length
      || messageProvenance.length !== messageParts.length
      || !messageParts.every((part, partIndex) => diagnosticPartsEqual(part, fragmentParts[partIndex]!))
    ) return [];
    return [messageProvenance];
  });
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const firstJson = JSON.stringify(first);
  if (matches.some((candidate) => JSON.stringify(candidate) !== firstJson)) return null;
  return first.map(clonePartProvenance);
}

function diagnosticContentParts(value: JsonValue): readonly JsonValue[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.content)) return value.content;
  if (Array.isArray(value.parts)) return value.parts;
  if (value.content !== undefined && value.content !== null) return [value.content];
  return [];
}

function diagnosticPartsEqual(canonical: JsonValue, provider: JsonValue): boolean {
  const canonicalText = diagnosticPartText(canonical);
  const providerText = diagnosticPartText(provider);
  if (canonicalText !== null || providerText !== null) return canonicalText === providerText;
  const canonicalImage = diagnosticImageDigest(canonical);
  const providerImage = diagnosticImageDigest(provider);
  if (canonicalImage !== null || providerImage !== null) return canonicalImage === providerImage;
  return stableJson(canonical) === stableJson(provider);
}

function diagnosticPartText(value: JsonValue): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  for (const key of ['text', 'input_text', 'output_text']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function diagnosticImageDigest(value: JsonValue): string | null {
  if (!isRecord(value)) return null;
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : null;
  const isImagePart = type === 'image'
    || type === 'input_image'
    || type === 'output_image'
    || type === 'image_url'
    || isRecord(value.inlineData)
    || isRecord(value.inline_data)
    || isRecord(value.image);
  return isImagePart ? nestedSha256(value) : null;
}

function nestedSha256(value: JsonValue): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const digest = nestedSha256(entry);
      if (digest) return digest;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) return value.sha256;
  for (const entry of Object.values(value)) {
    const digest = nestedSha256(entry as JsonValue);
    if (digest) return digest;
  }
  return null;
}

function clonePartProvenance(
  provenance: TurnDiagnosticsMessagePartProvenance,
): TurnDiagnosticsMessagePartProvenance {
  if (provenance.source === 'systemContext') {
    return { source: provenance.source, entries: provenance.entries.map((entry) => ({ ...entry })) };
  }
  return provenance.source === 'userInput'
    ? { source: provenance.source, itemId: provenance.itemId }
    : { source: provenance.source };
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

function jsonValue(value: unknown, omitImageBytes: boolean, nestedImageContainer = false): JsonValue {
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
  const imageData = omitImageBytes ? directImageBase64(value, nestedImageContainer) : null;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (imageData !== null && key === 'data') {
      result.data = base64Marker(imageData);
    } else {
      result[key] = jsonValue(
        entry,
        omitImageBytes,
        key === 'inlineData' || key === 'inline_data',
      );
    }
  }
  return result;
}

function directImageBase64(
  value: Readonly<Record<string, unknown>>,
  nestedImageContainer: boolean,
): string | null {
  if (typeof value.data !== 'string') return null;
  const mimeType = typeof value.mimeType === 'string'
    ? value.mimeType
    : typeof value.media_type === 'string' ? value.media_type : null;
  if (!mimeType?.toLowerCase().startsWith('image/')) return null;
  return nestedImageContainer || value.type === 'image' || value.type === 'base64'
    ? value.data
    : null;
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
