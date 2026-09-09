/** LinkeDOM does not perform the browser's checkbox activation before click dispatch. */
export function clickCheckbox(input: HTMLInputElement | null): void {
  if (!input || input.type !== 'checkbox') throw new Error('Missing checkbox');
  if (input.disabled) return;
  input.checked = !input.checked;
  input.click();
}
