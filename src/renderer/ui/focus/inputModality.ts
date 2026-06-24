type InputModality = 'keyboard' | 'pointer';

const MODIFIER_KEYS = new Set([
  'Alt',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
]);

const NUMBER_STEPPER_KEYS = new Set(['ArrowDown', 'ArrowUp']);

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
  if (event.key === 'Tab') return true;
  if (MODIFIER_KEYS.has(event.key)) return false;
  if (isNumberStepperKey(event)) return true;
  return !isTextEditingTarget(event.target);
}

function isNumberStepperKey(event: KeyboardEvent): boolean {
  return NUMBER_STEPPER_KEYS.has(event.key)
    && event.target instanceof HTMLInputElement
    && event.target.type === 'number';
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
