export function clampMenuIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export function nextMenuIndex(current: number, itemCount: number, direction: 'up' | 'down'): number {
  return clampMenuIndex(current + (direction === 'down' ? 1 : -1), itemCount);
}
