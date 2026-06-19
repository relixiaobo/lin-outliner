import { readFile } from 'node:fs/promises';
import type { NodeId } from '../core/types';
import {
  applyNodeAccess,
  normalizeNodeAccessStats,
  type NodeAccessSource,
  type NodeAccessStats,
} from '../core/nodeAccessRanking';
import { writeJsonFile } from './jsonFileStore';

interface PersistedNodeAccessFile {
  version: 1;
  nodes: Record<NodeId, NodeAccessStats>;
}

export interface NodeAccessStoreOptions {
  flushDelayMs?: number;
}

export class NodeAccessStore {
  private readonly flushDelayMs: number;
  private stats = new Map<NodeId, NodeAccessStats>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(private readonly filePath: string, options: NodeAccessStoreOptions = {}) {
    this.flushDelayMs = options.flushDelayMs ?? 750;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadFromDisk();
    await this.loadPromise;
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
    this.flushPromise = writeJsonFile(this.filePath, payload, { pretty: false, trailingNewline: false })
      .catch((error) => {
        this.dirty = true;
        throw error;
      })
      .finally(() => {
        this.flushPromise = null;
      });
    await this.flushPromise;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      this.stats = parseNodeAccessFile(parsed);
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
  }

  private serialize(): PersistedNodeAccessFile {
    const nodes: Record<NodeId, NodeAccessStats> = {};
    for (const [nodeId, stats] of this.stats) {
      const normalized = normalizeNodeAccessStats(stats);
      if (!normalized || normalized.s <= 0 || normalized.tUpdate === null) continue;
      nodes[nodeId] = normalized;
    }
    return { version: 1, nodes };
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
