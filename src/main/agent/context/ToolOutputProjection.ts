import type { Api, Model } from '../runtime/kernel/types';
import type {
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ToolOutputProjection,
  ToolOutputProjectionContextPayload,
  Turn,
} from '../../../core/agent/protocol';
import {
  toolItemVisibleOutputText,
  type HistoryToolItem,
} from './ContextProjector';
import { estimateTextTokens } from './ContextBudgetPlanner';
import { selectEffectiveContext } from './ContextEpoch';
import { outputReferenceKey } from './contextDependencies';

const MAX_FULL_OUTPUT_SHARE = 0.25;
const MAX_SINGLE_FULL_OUTPUT_TOKENS = 8_192;

export async function freezePendingToolOutputProjections(input: {
  readonly turns: readonly Turn[];
  readonly model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>;
  readonly readContext: (ref: ThreadContextPayloadReference) => Promise<ThreadContextPayload | null>;
  readonly persist: (
    payload: ToolOutputProjectionContextPayload,
    summary: string,
  ) => Promise<ContextEvidenceThreadItem>;
}): Promise<readonly ContextEvidenceThreadItem[]> {
  const existing = new Map<string, ToolOutputProjectionContextPayload>();
  const tools: HistoryToolItem[] = [];
  for (const turn of selectEffectiveContext(input.turns).turns) {
    for (const item of turn.items) {
      if (item.type === 'contextEvidence' && item.kind === 'toolOutputProjection') {
        const payload = await input.readContext(item.payloadRef);
        if (!payload || payload.kind !== 'toolOutputProjection') {
          throw new Error(`Tool-output projection is unavailable or corrupt: ${item.payloadRef.id}`);
        }
        const key = outputReferenceKey(payload.outputRef);
        const prior = existing.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(payload)) {
          throw new Error(`Tool output has conflicting frozen projections: ${payload.outputRef.id}`);
        }
        existing.set(key, payload);
      } else if (isCompletedToolWithOutput(item)) {
        tools.push(item);
      }
    }
  }

  const inputCapacity = Math.max(0, input.model.contextWindow - Math.min(
    input.model.maxTokens,
    Math.floor(input.model.contextWindow * MAX_FULL_OUTPUT_SHARE),
  ));
  let remainingFullTokens = Math.floor(inputCapacity * MAX_FULL_OUTPUT_SHARE);
  for (const payload of existing.values()) {
    if (payload.projection.type === 'full') {
      remainingFullTokens -= estimateOutputReferenceTokens(payload.outputRef.byteLength);
    }
  }

  const published: ContextEvidenceThreadItem[] = [];
  for (const item of tools) {
    const outputRef = item.outputRef;
    if (!outputRef || existing.has(outputReferenceKey(outputRef))) continue;
    const fullTokens = estimateOutputReferenceTokens(outputRef.byteLength);
    const visible = toolItemVisibleOutputText(item);
    const projection: ToolOutputProjection = fullTokens <= MAX_SINGLE_FULL_OUTPUT_TOKENS
      && fullTokens <= remainingFullTokens
      ? { type: 'full' }
      : {
          type: 'inline',
          text: [
            `[Frozen tool output projection: ${outputRef.byteLength} bytes, sha256=${outputRef.id}, full output available from the canonical Item.]`,
            visible,
          ].join('\n'),
        };
    const payload: ToolOutputProjectionContextPayload = {
      schemaVersion: 1,
      kind: 'toolOutputProjection',
      outputRef,
      projection,
    };
    const evidence = await input.persist(
      payload,
      `Frozen tool output (${projection.type}, ${outputRef.byteLength} bytes)`,
    );
    existing.set(outputReferenceKey(outputRef), payload);
    published.push(evidence);
    if (projection.type === 'full') remainingFullTokens -= fullTokens;
  }
  return published;
}

function estimateOutputReferenceTokens(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / 4));
}

function isCompletedToolWithOutput(item: Turn['items'][number]): item is HistoryToolItem {
  return (
    item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch'
  ) && item.status !== 'inProgress' && item.outputRef !== null;
}
