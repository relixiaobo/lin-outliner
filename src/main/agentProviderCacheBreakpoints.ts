import type { Api, Model } from '@earendil-works/pi-ai';
import { splitAgentPromptForL0CacheBreakpoint } from './agentSystemPrompt';

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

interface AgentPromptCacheBreakpointOptions {
  enabled: boolean;
  systemPrompt: string;
}

interface CacheControlRef {
  target: Record<string, unknown>;
  protectedBreakpoint: boolean;
  preferredRemoval: boolean;
}

export function applyAgentPromptCacheBreakpoints(
  payload: unknown,
  model: Model<Api>,
  options: AgentPromptCacheBreakpointOptions,
): unknown | undefined {
  if (!options.enabled || model.api !== 'anthropic-messages') return undefined;
  if (!isRecord(payload) || !Array.isArray(payload.system)) return undefined;
  if (!splitAgentPromptForL0CacheBreakpoint(options.systemPrompt)) return undefined;

  let replaced = false;
  const protectedBlocks = new Set<Record<string, unknown>>();
  const preferredRemovalBlocks = new Set<Record<string, unknown>>();
  const system = payload.system.flatMap((block): unknown[] => {
    if (!isRecord(block)) return [block];
    const split = typeof block.text === 'string'
      ? splitAgentPromptForL0CacheBreakpoint(block.text)
      : null;
    if (block.type !== 'text' || !split || !('cache_control' in block)) {
      const systemBlock = { ...block };
      if ('cache_control' in systemBlock) preferredRemovalBlocks.add(systemBlock);
      return [systemBlock];
    }
    replaced = true;
    const l0Block = { ...block, text: split.l0Prompt };
    const restBlock = { ...block, text: split.restPrompt };
    protectedBlocks.add(l0Block);
    protectedBlocks.add(restBlock);
    return [l0Block, restBlock];
  });
  if (!replaced) return undefined;

  payload.system = system;
  enforceAnthropicCacheControlLimit(payload, protectedBlocks, preferredRemovalBlocks);
  return payload;
}

function enforceAnthropicCacheControlLimit(
  payload: Record<string, unknown>,
  protectedBlocks: ReadonlySet<Record<string, unknown>>,
  preferredRemovalBlocks: ReadonlySet<Record<string, unknown>>,
): void {
  const refs = collectCacheControlRefs(payload, protectedBlocks, preferredRemovalBlocks);
  if (refs.length <= ANTHROPIC_CACHE_CONTROL_LIMIT) return;
  const removableRefs = refs
    .filter((candidate) => !candidate.protectedBreakpoint)
    .sort((a, b) => Number(b.preferredRemoval) - Number(a.preferredRemoval));
  const removeCount = Math.min(refs.length - ANTHROPIC_CACHE_CONTROL_LIMIT, removableRefs.length);
  for (const ref of removableRefs.slice(0, removeCount)) {
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
  for (const child of Object.values(value)) collectCacheControlRefs(child, protectedBlocks, preferredRemovalBlocks, refs);
  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
