import { readFile } from 'node:fs/promises';
import type { NodeId } from '../core/types';
import {
  applyNodeAccess,
  computeNodeAccessStrength,
  normalizeNodeAccessStats,
  type NodeAccessSource,
  type NodeAccessStats,
} from '../core/nodeAccessRanking';
import { PRIVATE_JSON_FILE_OPTIONS, writeJsonFile } from './jsonFileStore';

interface PersistedNodeAccessFile {
  version: 1;
  nodes: Record<NodeId, NodeAccessStats>;
}

export interface NodeAccessStoreOptions {
  flushDelayMs?: number;
  maxEntries?: number;
  onError?: (error: unknown, operation: 'load' | 'flush') => void;
}

export class NodeAccessStore {
  private readonly flushDelayMs: number;
  private readonly maxEntries: number;
  private readonly onError?: (error: unknown, operation: 'load' | 'flush') => void;
  private stats = new Map<NodeId, NodeAccessStats>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(private readonly filePath: string, options: NodeAccessStoreOptions = {}) {
    this.flushDelayMs = options.flushDelayMs ?? 750;
    this.maxEntries = options.maxEntries ?? 5000;
    this.onError = options.onError;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadFromDisk().catch((error) => {
      this.loadPromise = null;
      throw error;
    });
    await this.loadPromise;
  }

  get(nodeId: NodeId): NodeAccessStats | undefined {
    return this.stats.get(nodeId);
  }

  snapshot(): Map<NodeId, NodeAccessStats> {
    return new Map(this.stats);
  }

  async recordMany(nodeIds: readonly NodeId[], source: NodeAccessSource, now = Date.now()): Promise<void> {
    await this.load();
    const uniqueNodeIds = [...new Set(nodeIds.filter((nodeId) => typeof nodeId === 'string' && nodeId.length > 0))];
    if (uniqueNodeIds.length === 0) return;
    for (const nodeId of uniqueNodeIds) {
      this.stats.set(nodeId, applyNodeAccess(this.stats.get(nodeId), source, now));
    }
    this.compactInMemory();
    this.dirty = true;
    this.scheduleFlush();
  }

  async deleteMany(nodeIds: readonly NodeId[]): Promise<void> {
    await this.load();
    let changed = false;
    for (const nodeId of nodeIds) {
      changed = this.stats.delete(nodeId) || changed;
    }
    if (!changed) return;
    this.dirty = true;
    this.scheduleFlush();
  }

  async retainOnly(nodeIds: Iterable<NodeId>): Promise<void> {
    await this.load();
    const keep = new Set(nodeIds);
    let changed = false;
    for (const nodeId of this.stats.keys()) {
      if (keep.has(nodeId)) continue;
      this.stats.delete(nodeId);
      changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    this.scheduleFlush();
  }

  async flushNow(): Promise<void> {
    await this.load();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;

    const payload = this.serialize();
    this.dirty = false;
    this.flushPromise = writeJsonFile(this.filePath, payload, {
      ...PRIVATE_JSON_FILE_OPTIONS,
      pretty: false,
      trailingNewline: false,
    })
      .catch((error) => {
        this.dirty = true;
        this.reportError(error, 'flush');
        this.scheduleFlush();
        throw error;
      })
      .finally(() => {
        this.flushPromise = null;
      });
    await this.flushPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) {
        this.stats = new Map();
        this.loaded = true;
        return;
      }
      this.reportError(error, 'load');
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      this.stats = parseNodeAccessFile(parsed);
      this.compactInMemory();
    } catch {
      this.stats = new Map();
    } finally {
      this.loaded = true;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow().catch(() => undefined);
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private serialize(): PersistedNodeAccessFile {
    const nodes: Record<NodeId, NodeAccessStats> = {};
    for (const [nodeId, stats] of this.compactEntriesForPersistence()) {
      const normalized = normalizeNodeAccessStats(stats);
      if (!normalized || normalized.s <= 0 || normalized.tUpdate === null) continue;
      nodes[nodeId] = normalized;
    }
    return { version: 1, nodes };
  }

  private compactEntriesForPersistence(): Array<[NodeId, NodeAccessStats]> {
    const entries = [...this.stats.entries()];
    if (entries.length <= this.maxEntries) return entries;
    const now = Date.now();
    return entries
      .map(([nodeId, stats]) => ({ nodeId, stats, strength: computeNodeAccessStrength(stats, now) }))
      .sort((left, right) => right.strength - left.strength || left.nodeId.localeCompare(right.nodeId))
      .slice(0, this.maxEntries)
      .map((entry) => [entry.nodeId, entry.stats]);
  }

  private compactInMemory(): void {
    if (this.stats.size <= this.maxEntries) return;
    this.stats = new Map(this.compactEntriesForPersistence());
  }

  private reportError(error: unknown, operation: 'load' | 'flush'): void {
    this.onError?.(error, operation);
  }
}

function parseNodeAccessFile(value: unknown): Map<NodeId, NodeAccessStats> {
  if (!value || typeof value !== 'object') return new Map();
  const file = value as Partial<PersistedNodeAccessFile>;
  if (file.version !== 1 || !file.nodes || typeof file.nodes !== 'object') return new Map();

  const stats = new Map<NodeId, NodeAccessStats>();
  for (const [nodeId, rawStats] of Object.entries(file.nodes)) {
    const normalized = normalizeNodeAccessStats(rawStats);
    if (!normalized || normalized.s <= 0 || normalized.tUpdate === null) continue;
    stats.set(nodeId, normalized);
  }
  return stats;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
