export function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

export function removeFromSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

export function intersectSets<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) result.add(value);
  }
  return result;
}

export function intersectSetList<T>(sets: Iterable<Set<T>>): Set<T> {
  const sorted = [...sets].sort((left, right) => left.size - right.size);
  if (sorted.length === 0) return new Set();
  let result = new Set(sorted[0]!);
  for (let index = 1; index < sorted.length; index += 1) {
    result = intersectSets(result, sorted[index]!);
    if (result.size === 0) break;
  }
  return result;
}

export function unionSets<T>(sets: Iterable<Set<T>>): Set<T> {
  const result = new Set<T>();
  for (const set of sets) {
    for (const value of set) result.add(value);
  }
  return result;
}
