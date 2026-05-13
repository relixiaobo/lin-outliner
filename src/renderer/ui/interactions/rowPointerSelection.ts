export type RowPointerSelectAction = 'single' | 'toggle' | 'range' | null;

export function resolveRowPointerSelectAction(params: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isEditing?: boolean;
  allowSingle?: boolean;
}): RowPointerSelectAction {
  if (params.isEditing) return null;
  if (params.metaKey || params.ctrlKey) return 'toggle';
  if (params.shiftKey) return 'range';
  return params.allowSingle ? 'single' : null;
}

export function shouldPreserveSelectedRowContextClick(params: {
  button: number;
  rowSelected: boolean;
}): boolean {
  return params.rowSelected && params.button === 2;
}
