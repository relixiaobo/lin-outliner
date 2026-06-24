type InputModality = 'keyboard' | 'pointer';

const NAVIGATION_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  'Tab',
]);

export function installInputModalityTracking(
  ownerDocument: Document = document,
): () => void {
  const root = ownerDocument.documentElement;

  const setModality = (modality: InputModality) => {
    root.dataset.inputModality = modality;
  };

  const handlePointerDown = () => setModality('pointer');
  const handleKeyDown = (event: KeyboardEvent) => {
    if (usesKeyboardFocusModality(event)) setModality('keyboard');
  };

  setModality('pointer');
  ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
  ownerDocument.addEventListener('keydown', handleKeyDown, true);

  return () => {
    ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
    ownerDocument.removeEventListener('keydown', handleKeyDown, true);
  };
}

function usesKeyboardFocusModality(event: KeyboardEvent): boolean {
  if (!NAVIGATION_KEYS.has(event.key)) return false;
  if (event.key === 'Tab') return true;
  return !isTextEditingTarget(event.target);
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable="true"]')) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(target.type);
}
