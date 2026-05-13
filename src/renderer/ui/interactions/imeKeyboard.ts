export interface ImeKeyboardEventLike {
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  which?: number;
}

export function isImeComposingEvent(event: ImeKeyboardEventLike | null | undefined): boolean {
  if (!event) return false;
  if (event.isComposing) return true;
  if (event.key === 'Process') return true;
  const legacyCode = event.keyCode ?? event.which;
  return legacyCode === 229;
}
