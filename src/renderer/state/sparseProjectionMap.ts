import type { NodeId, NodeProjection } from '../api/types';

const BUCKET_COUNT = 1024;
const BUCKET_MASK = BUCKET_COUNT - 1;

function bucketIndex(id: NodeId): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash & BUCKET_MASK;
}

function emptyBuckets<TValue>(): Array<ReadonlyMap<NodeId, TValue>> {
  return Array.from({ length: BUCKET_COUNT }, () => new Map<NodeId, TValue>());
}

function mapIterator<TValue>(iterator: IterableIterator<TValue>): MapIterator<TValue> {
  return iterator as MapIterator<TValue>;
}

export class SparseProjectionMap<TValue> extends Map<NodeId, TValue> {
  private constructor(
    private readonly buckets: readonly ReadonlyMap<NodeId, TValue>[],
    private readonly order: readonly NodeId[],
    private readonly entryCount: number,
  ) {
    super();
  }

  static fromEntries<TValue>(entries: Iterable<readonly [NodeId, TValue]>): SparseProjectionMap<TValue> {
    const buckets = emptyBuckets<TValue>() as Map<NodeId, TValue>[];
    const order: NodeId[] = [];
    let entryCount = 0;
    for (const [id, value] of entries) {
      const bucket = buckets[bucketIndex(id)]!;
      if (!bucket.has(id)) {
        order.push(id);
        entryCount += 1;
      }
      bucket.set(id, value);
    }
    return new SparseProjectionMap(buckets, order, entryCount);
  }

  static fromReadonlyMap<TValue>(map: ReadonlyMap<NodeId, TValue>): SparseProjectionMap<TValue> {
    return map instanceof SparseProjectionMap ? map : SparseProjectionMap.fromEntries(map.entries());
  }

  get orderedIds(): readonly NodeId[] {
    return this.order;
  }

  override get size(): number {
    return this.entryCount;
  }

  override get(id: NodeId): TValue | undefined {
    return this.buckets[bucketIndex(id)]!.get(id);
  }

  override has(id: NodeId): boolean {
    return this.buckets[bucketIndex(id)]!.has(id);
  }

  patch(
    upserts: readonly (readonly [NodeId, TValue])[],
    removedIds: readonly NodeId[],
  ): SparseProjectionMap<TValue> {
    if (upserts.length === 0 && removedIds.length === 0) return this;

    let buckets: Array<ReadonlyMap<NodeId, TValue>> | null = null;
    const copiedBuckets = new Map<number, Map<NodeId, TValue>>();
    const mutableBucket = (id: NodeId): Map<NodeId, TValue> => {
      const index = bucketIndex(id);
      const existing = copiedBuckets.get(index);
      if (existing) return existing;
      const copy = new Map(this.buckets[index]);
      copiedBuckets.set(index, copy);
      buckets ??= this.buckets.slice();
      buckets[index] = copy;
      return copy;
    };

    let entryCount = this.entryCount;
    let removedExisting: Set<NodeId> | null = null;
    const addedIds: NodeId[] = [];

    for (const id of removedIds) {
      const bucket = mutableBucket(id);
      if (!bucket.has(id)) continue;
      bucket.delete(id);
      entryCount -= 1;
      (removedExisting ??= new Set<NodeId>()).add(id);
    }

    for (const [id, value] of upserts) {
      const existedBefore = this.has(id);
      const wasRemoved = removedExisting?.has(id) ?? false;
      const bucket = mutableBucket(id);
      const existsNow = bucket.has(id);
      bucket.set(id, value);
      if (!existsNow) entryCount += 1;
      if (!existedBefore || wasRemoved) addedIds.push(id);
    }

    if (!buckets) return this;

    let order = this.order;
    if (removedExisting || addedIds.length > 0) {
      order = removedExisting
        ? this.order.filter((id) => !removedExisting!.has(id))
        : this.order;
      if (addedIds.length > 0) order = [...order, ...addedIds];
    }

    return new SparseProjectionMap(buckets, order, entryCount);
  }

  override keys(): MapIterator<NodeId> {
    return mapIterator(this.order[Symbol.iterator]());
  }

  override values(): MapIterator<TValue> {
    return mapIterator((function* values(self: SparseProjectionMap<TValue>) {
      for (const id of self.order) {
        const value = self.get(id);
        if (value === undefined) throw new Error(`SparseProjectionMap missing ordered id: ${id}`);
        yield value;
      }
    }(this)));
  }

  override entries(): MapIterator<[NodeId, TValue]> {
    return mapIterator((function* entries(self: SparseProjectionMap<TValue>) {
      for (const id of self.order) {
        const value = self.get(id);
        if (value === undefined) throw new Error(`SparseProjectionMap missing ordered id: ${id}`);
        yield [id, value] as [NodeId, TValue];
      }
    }(this)));
  }

  override [Symbol.iterator](): MapIterator<[NodeId, TValue]> {
    return this.entries();
  }

  override forEach(
    callbackfn: (value: TValue, key: NodeId, map: Map<NodeId, TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, value] of this) callbackfn.call(thisArg, value, id, this);
  }

  override set(_id: NodeId, _value: TValue): this {
    throw new Error('SparseProjectionMap is a read-only projection snapshot');
  }

  override delete(_id: NodeId): boolean {
    throw new Error('SparseProjectionMap is a read-only projection snapshot');
  }

  override clear(): void {
    throw new Error('SparseProjectionMap is a read-only projection snapshot');
  }
}

function isArrayIndex(prop: string | symbol): prop is string {
  if (typeof prop !== 'string' || prop.length === 0) return false;
  const index = Number(prop);
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === prop;
}

export function projectionNodesView(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  ids: readonly NodeId[],
): NodeProjection[] {
  const target: NodeProjection[] = [];
  target.length = ids.length;

  const nodeAt = (index: number): NodeProjection => {
    const id = ids[index];
    const node = id === undefined ? undefined : byId.get(id);
    if (!node) throw new Error(`Projection nodes view missing id at index ${index}`);
    return node;
  };

  return new Proxy(target, {
    get(arrayTarget, prop, receiver) {
      if (prop === 'length') return ids.length;
      if (prop === Symbol.iterator) {
        return function* iterateProjectionNodes() {
          for (let index = 0; index < ids.length; index += 1) yield nodeAt(index);
        };
      }
      if (isArrayIndex(prop)) return nodeAt(Number(prop));
      return Reflect.get(arrayTarget, prop, receiver);
    },
    has(arrayTarget, prop) {
      if (isArrayIndex(prop)) return Number(prop) < ids.length;
      return Reflect.has(arrayTarget, prop);
    },
    getOwnPropertyDescriptor(arrayTarget, prop) {
      if (isArrayIndex(prop) && Number(prop) < ids.length) {
        return {
          configurable: true,
          enumerable: true,
          value: nodeAt(Number(prop)),
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(arrayTarget, prop);
    },
  });
}
