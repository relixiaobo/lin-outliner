export function beginKeyedMutation(generations: Map<string, number>, key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

export function isCurrentKeyedMutation(
  generations: ReadonlyMap<string, number>,
  key: string,
  generation: number,
): boolean {
  return generations.get(key) === generation;
}
