export const DIALOG_NESTED_OVERLAY_ATTRIBUTE = 'data-dialog-nested-overlay';
export const DIALOG_NESTED_OVERLAY_SELECTOR = `[${DIALOG_NESTED_OVERLAY_ATTRIBUTE}="true"]`;

export function isDialogNestedOverlayTarget(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest;
  return typeof closest === 'function'
    && Boolean(closest.call(target, DIALOG_NESTED_OVERLAY_SELECTOR));
}
