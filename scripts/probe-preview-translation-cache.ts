import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  PREVIEW_TRANSLATION_CACHE_MAX_BYTES,
  PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES,
  PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES,
  PreviewTranslationCacheStore,
  type PreviewTranslationCacheBlock,
  type PreviewTranslationCacheScope,
} from '../src/main/previewTranslationCacheStore';

const HEARTBEAT_MS = 5;

interface Measurement<T> {
  elapsedMs: number;
  maxEventLoopStallMs: number;
  result: T;
}

async function measure<T>(task: () => Promise<T>): Promise<Measurement<T>> {
  let maxEventLoopStallMs = 0;
  let lastHeartbeatAt = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxEventLoopStallMs = Math.max(maxEventLoopStallMs, now - lastHeartbeatAt - HEARTBEAT_MS);
    lastHeartbeatAt = now;
  }, HEARTBEAT_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedAt = performance.now();
  try {
    const result = await task();
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2));
    return {
      elapsedMs: performance.now() - startedAt,
      maxEventLoopStallMs,
      result,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

function syntheticBlocks(count: number, offset = 0): PreviewTranslationCacheBlock[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + offset;
    return {
      cacheKey: `block:${sequence}`,
      id: `b${sequence}`,
      text: `Synthetic source passage ${sequence}`,
    };
  });
}

async function main(): Promise<void> {
  const entryCount = Number(process.env.PREVIEW_TRANSLATION_CACHE_PROBE_ENTRIES ?? PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES);
  if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES) {
    throw new Error(`PREVIEW_TRANSLATION_CACHE_PROBE_ENTRIES must be between 1 and ${PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES}.`);
  }

  const root = await mkdtemp(path.join(tmpdir(), 'tenon-preview-translation-cache-probe-'));
  const cacheRoot = path.join(root, 'cache');
  const scope = (index: number): PreviewTranslationCacheScope => ({
    contentKind: 'page',
    modelIdentity: 'probe:model',
    promptRevision: 1,
    sourceId: `probe:source:${index}`,
    targetLanguage: 'zh-Hans',
  });
  let now = 1;
  try {
    const store = new PreviewTranslationCacheStore(cacheRoot, {
      flushDelayMs: 60_000,
      now: () => now,
    });
    const populate = await measure(async () => {
      for (let offset = 0, scopeIndex = 0; offset < entryCount; scopeIndex += 1) {
        const count = Math.min(PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES, entryCount - offset);
        const blocks = syntheticBlocks(count, offset);
        const translations = blocks.map(({ id }, index) => ({
          id,
          translation: `Synthetic translated passage ${offset + index}`,
        }));
        const currentScope = scope(scopeIndex);
        const initial = await store.lookup(currentScope, blocks);
        now += 1;
        await store.record(currentScope, blocks, translations, initial.epoch);
        offset += count;
      }
      await store.flushNow();
    });

    const lastScopeIndex = Math.max(0, Math.ceil(entryCount / PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES) - 1);
    const lastScopeOffset = lastScopeIndex * PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES;
    const lastScopeCount = entryCount - lastScopeOffset;
    const reopened = new PreviewTranslationCacheStore(cacheRoot, {
      flushDelayMs: 60_000,
      now: () => now,
    });
    const sample = syntheticBlocks(lastScopeCount, lastScopeOffset)
      .filter((_, index) => index % Math.max(1, Math.floor(lastScopeCount / 256)) === 0)
      .slice(0, 256);
    const lookup = await measure(() => reopened.lookup(scope(lastScopeIndex), sample));
    if (lookup.result.hits.length !== sample.length) {
      throw new Error(`Cold lookup restored ${lookup.result.hits.length} of ${sample.length} sampled entries.`);
    }

    now += 1;
    const overflowCount = Math.min(1_000, entryCount);
    const overflowBlocks = syntheticBlocks(overflowCount, entryCount);
    const overflowTranslations = overflowBlocks.map(({ id }, index) => ({
      id,
      translation: `Synthetic overflow translation ${index}`,
    }));
    const overflowScope = scope(lastScopeIndex + 1);
    const overflowLookup = await reopened.lookup(overflowScope, overflowBlocks);
    const compact = await measure(async () => {
      await reopened.record(overflowScope, overflowBlocks, overflowTranslations, overflowLookup.epoch);
      await reopened.flushNow();
    });

    const manifest = JSON.parse(await readFile(path.join(cacheRoot, 'index.json'), 'utf8')) as {
      scopes?: Record<string, { bytes?: number; entries?: number }>;
    };
    const metadata = Object.values(manifest.scopes ?? {});
    const logicalBytes = metadata.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    const retainedEntries = metadata.reduce((sum, entry) => sum + (entry.entries ?? 0), 0);
    const expectedRetainedEntries = Math.min(
      entryCount + overflowCount,
      PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES,
    );
    if (retainedEntries !== expectedRetainedEntries) {
      throw new Error(
        `Cache retained ${retainedEntries} entries instead of the expected ${expectedRetainedEntries}.`,
      );
    }
    if (logicalBytes > PREVIEW_TRANSLATION_CACHE_MAX_BYTES) {
      throw new Error(`Cache retained ${logicalBytes} logical bytes above its configured bound.`);
    }

    console.log(JSON.stringify({
      entryCount,
      overflowCount,
      retainedEntries,
      logicalBytes,
      scopes: metadata.length,
      files: (await readdir(cacheRoot)).length,
      populate: {
        elapsedMs: populate.elapsedMs,
        maxEventLoopStallMs: populate.maxEventLoopStallMs,
      },
      coldLookup: {
        elapsedMs: lookup.elapsedMs,
        hits: lookup.result.hits.length,
        maxEventLoopStallMs: lookup.maxEventLoopStallMs,
      },
      compact: {
        elapsedMs: compact.elapsedMs,
        maxEventLoopStallMs: compact.maxEventLoopStallMs,
      },
    }, null, 2));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
