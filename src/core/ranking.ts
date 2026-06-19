export function cappedMultiplier(signal: number, weight: number, cap: number): number {
  const safeSignal = Number.isFinite(signal) ? Math.max(0, signal) : 0;
  const safeWeight = Number.isFinite(weight) ? Math.max(0, weight) : 0;
  const safeCap = Number.isFinite(cap) ? Math.max(0, cap) : 0;
  return 1 + Math.min(safeCap, safeSignal * safeWeight);
}
