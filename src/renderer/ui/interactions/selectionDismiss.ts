export function shouldPreserveSelectionForModifierGesture(params: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return params.metaKey || params.ctrlKey || params.shiftKey || params.altKey;
}

export function shouldClearSelectionOnPointerDown(target: HTMLElement | null): boolean {
  if (target?.closest('[data-preserve-selection]')) return false;
  if (target?.closest('[data-node-id][data-parent-id]')) return false;
  return true;
}

export function shouldClearSelectionOnFocusIn(target: HTMLElement | null): boolean {
  if (target?.closest('[data-preserve-selection]')) return false;
  if (target?.closest('[data-node-id][data-parent-id]')) return false;
  return true;
}
