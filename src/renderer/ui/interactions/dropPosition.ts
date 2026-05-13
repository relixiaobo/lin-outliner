export type DropHoverPosition = 'before' | 'after' | 'inside';

export function resolveDropHoverPosition(params: {
  offsetY: number;
  rowHeight: number;
}): DropHoverPosition {
  if (params.rowHeight <= 0) return 'inside';

  const third = params.rowHeight / 3;
  if (params.offsetY < third) return 'before';
  if (params.offsetY > third * 2) return 'after';
  return 'inside';
}
