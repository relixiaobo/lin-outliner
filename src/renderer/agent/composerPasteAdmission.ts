export const MAX_AUTOMATIC_PASTE_UTF16_UNITS = 8 * 1024 * 1024;
export const MAX_INLINE_PASTE_UTF8_BYTES = 4 * 1024;
export const MAX_INLINE_PASTE_BREAKS = 2_000;
export const MAX_COMPOSER_UTF16_UNITS = 256 * 1024;
export const MAX_COMPOSER_INLINE_ATOMS = 8_000;

const UTF8_ENCODER = new TextEncoder();

export interface ComposerContentMetrics {
  readonly inlineAtoms: number;
  readonly utf16Units: number;
}

export interface ComposerPasteAdmissionInput {
  readonly current: ComposerContentMetrics;
  readonly incomingText: string;
  readonly selected: ComposerContentMetrics;
}

export type ComposerPasteAdmission =
  | { readonly outcome: 'attach'; readonly incoming: ComposerContentMetrics; readonly projected: ComposerContentMetrics }
  | { readonly outcome: 'inline'; readonly incoming: ComposerContentMetrics; readonly projected: ComposerContentMetrics }
  | { readonly outcome: 'reject-ceiling'; readonly incoming: ComposerContentMetrics; readonly projected: null }
  | { readonly outcome: 'reject-draft-budget'; readonly incoming: ComposerContentMetrics; readonly projected: ComposerContentMetrics };

export function classifyComposerPaste(input: ComposerPasteAdmissionInput): ComposerPasteAdmission {
  if (input.incomingText.length > MAX_AUTOMATIC_PASTE_UTF16_UNITS) {
    return {
      incoming: { inlineAtoms: 0, utf16Units: input.incomingText.length },
      outcome: 'reject-ceiling',
      projected: null,
    };
  }
  const incoming = measureComposerText(input.incomingText);
  const projected = {
    inlineAtoms: Math.max(0, input.current.inlineAtoms - input.selected.inlineAtoms) + incoming.inlineAtoms,
    utf16Units: Math.max(0, input.current.utf16Units - input.selected.utf16Units) + incoming.utf16Units,
  };
  if (
    UTF8_ENCODER.encode(input.incomingText).byteLength >= MAX_INLINE_PASTE_UTF8_BYTES
    || incoming.inlineAtoms > MAX_INLINE_PASTE_BREAKS
  ) return { incoming, outcome: 'attach', projected };
  if (
    projected.utf16Units > MAX_COMPOSER_UTF16_UNITS
    || projected.inlineAtoms > MAX_COMPOSER_INLINE_ATOMS
  ) return { incoming, outcome: 'reject-draft-budget', projected };
  return { incoming, outcome: 'inline', projected };
}

export function measureComposerText(text: string, stopAfterAtoms = Number.POSITIVE_INFINITY): ComposerContentMetrics {
  let inlineAtoms = 0;
  let normalizedUnits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      inlineAtoms += 1;
      normalizedUnits += 1;
    } else if (unit === 10) {
      inlineAtoms += 1;
      normalizedUnits += 1;
    } else {
      normalizedUnits += 1;
    }
    if (inlineAtoms >= stopAfterAtoms) break;
  }
  return { inlineAtoms, utf16Units: normalizedUnits };
}
