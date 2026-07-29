import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  INITIAL_CONTEXT_EPOCH_ID,
  providerCacheAffinityMaterial,
} from '../../../core/agent/cacheAffinity';
import type { Turn } from '../../../core/agent/protocol';
import { latestContextEpochId } from './ContextEpoch';
import type { StablePrompt } from './stablePrompt';

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

interface CacheControlRef {
  readonly target: Record<string, unknown>;
  readonly protectedBreakpoint: boolean;
  readonly preferredRemoval: boolean;
}

export function providerCacheAffinity(threadId: string, turns: readonly Turn[]): string {
  const epochId = latestContextEpochId(turns, INITIAL_CONTEXT_EPOCH_ID);
  return createHash('sha256')
    .update(providerCacheAffinityMaterial(threadId, epochId))
    .digest('hex');
}

export function applyAnthropicStablePromptCacheBreakpoints(
  payload: unknown,
  model: Model<Api>,
  prompt: StablePrompt,
): unknown | undefined {
  if (model.api !== 'anthropic-messages' || !isRecord(payload) || !Array.isArray(payload.system)) {
    return undefined;
  }
  const segments = providerPromptSegments(prompt);
  if (!segments) return undefined;

  let replaced = false;
  const protectedBlocks = new Set<Record<string, unknown>>();
  const preferredRemovalBlocks = new Set<Record<string, unknown>>();
  const system = payload.system.flatMap((value): unknown[] => {
    if (!isRecord(value)) return [value];
    const block = { ...value };
    const blockText = typeof block.text === 'string' ? sanitizeProviderText(block.text) : null;
    if (
      block.type !== 'text'
      || blockText !== segments.complete
      || !('cache_control' in block)
    ) {
      if ('cache_control' in block) preferredRemovalBlocks.add(block);
      return [block];
    }
    replaced = true;
    const l0Block = { ...block, text: segments.l0 };
    const executionBlock = { ...block, text: segments.execution };
    protectedBlocks.add(l0Block);
    protectedBlocks.add(executionBlock);
    return [l0Block, executionBlock];
  });
  if (!replaced) return undefined;

  const result = { ...payload, system };
  enforceAnthropicCacheControlLimit(result, protectedBlocks, preferredRemovalBlocks);
  return result;
}

function providerPromptSegments(prompt: StablePrompt): {
  readonly complete: string;
  readonly l0: string;
  readonly execution: string;
} | null {
  const l0 = sanitizeProviderText(prompt.blocks
    .filter((block) => block.layer === 'L0')
    .map((block) => block.text)
    .join('\n\n'));
  const execution = sanitizeProviderText(prompt.blocks
    .filter((block) => block.layer !== 'L0')
    .map((block) => block.text)
    .join('\n\n'));
  if (!l0 || !execution) return null;
  const complete = sanitizeProviderText(prompt.text);
  if (complete !== `${l0}\n\n${execution}`) {
    throw new Error('Stable prompt blocks do not reconstruct the provider prompt.');
  }
  return { complete, l0, execution };
}

function enforceAnthropicCacheControlLimit(
  payload: Record<string, unknown>,
  protectedBlocks: ReadonlySet<Record<string, unknown>>,
  preferredRemovalBlocks: ReadonlySet<Record<string, unknown>>,
): void {
  const refs = collectCacheControlRefs(payload, protectedBlocks, preferredRemovalBlocks);
  if (refs.length <= ANTHROPIC_CACHE_CONTROL_LIMIT) return;
  const removable = refs
    .filter((ref) => !ref.protectedBreakpoint)
    .sort((left, right) => Number(right.preferredRemoval) - Number(left.preferredRemoval));
  for (const ref of removable.slice(0, refs.length - ANTHROPIC_CACHE_CONTROL_LIMIT)) {
    delete ref.target.cache_control;
  }
}

function collectCacheControlRefs(
  value: unknown,
  protectedBlocks: ReadonlySet<Record<string, unknown>>,
  preferredRemovalBlocks: ReadonlySet<Record<string, unknown>>,
  refs: CacheControlRef[] = [],
): CacheControlRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCacheControlRefs(item, protectedBlocks, preferredRemovalBlocks, refs);
    return refs;
  }
  if (!isRecord(value)) return refs;
  if ('cache_control' in value) {
    refs.push({
      target: value,
      protectedBreakpoint: protectedBlocks.has(value),
      preferredRemoval: preferredRemovalBlocks.has(value),
    });
  }
  for (const child of Object.values(value)) {
    collectCacheControlRefs(child, protectedBlocks, preferredRemovalBlocks, refs);
  }
  return refs;
}

function sanitizeProviderText(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
