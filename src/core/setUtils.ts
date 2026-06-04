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

export function unionSets<T>(sets: Iterable<Set<T>>): Set<T> {
  const result = new Set<T>();
  for (const set of sets) {
    for (const value of set) result.add(value);
  }
  return result;
}
