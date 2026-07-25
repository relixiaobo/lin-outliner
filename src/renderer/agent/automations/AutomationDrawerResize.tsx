import { useCallback, useLayoutEffect } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { localStorageOrNull } from '../../state/localStorageStore';

const DRAWER_HEIGHT_RATIO_STORAGE_KEY = 'tenon:automation-drawer-height-ratio';
const DRAWER_DEFAULT_HEIGHT_RATIO = 0.8;
const DRAWER_MIN_HEIGHT_PX = 360;
const DRAWER_TOP_GAP_PX = 52;
const DRAWER_KEYBOARD_STEP_PX = 48;

export function clampAutomationDrawerHeight(height: number, maxHeight: number): number {
  const upperBound = Math.max(0, maxHeight);
  const lowerBound = Math.min(DRAWER_MIN_HEIGHT_PX, upperBound);
  return Math.min(Math.max(height, lowerBound), upperBound);
}

function clampHeightRatio(ratio: number): number {
  return Math.min(Math.max(ratio, 0), 1);
}

function drawerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.automation-drawer');
}

function drawerMaxHeight(drawer: HTMLElement): number {
  const availableHeight = drawer.parentElement?.getBoundingClientRect().height ?? 0;
  return Math.max(0, availableHeight - DRAWER_TOP_GAP_PX);
}

function readHeightRatio(): number {
  const raw = localStorageOrNull()?.getItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY);
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? clampHeightRatio(parsed) : DRAWER_DEFAULT_HEIGHT_RATIO;
}

function writeHeightRatio(height: number, maxHeight: number): void {
  const storage = localStorageOrNull();
  if (!storage || maxHeight <= 0) return;
  try {
    storage.setItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY, clampHeightRatio(height / maxHeight).toFixed(4));
  } catch {
    // Renderer preferences are best effort.
  }
}

function setDrawerHeight(height: number, persist: boolean): void {
  const drawer = drawerElement();
  if (!drawer) return;
  const maxHeight = drawerMaxHeight(drawer);
  const nextHeight = clampAutomationDrawerHeight(height, maxHeight);
  drawer.style.setProperty('--automation-drawer-height', `${nextHeight}px`);
  if (persist) writeHeightRatio(nextHeight, maxHeight);
}

function applyStoredHeight(): void {
  const drawer = drawerElement();
  if (!drawer) return;
  setDrawerHeight(drawerMaxHeight(drawer) * readHeightRatio(), false);
}

export function useAutomationDrawerHeight(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return undefined;
    applyStoredHeight();
    const frame = window.requestAnimationFrame(applyStoredHeight);
    window.addEventListener('resize', applyStoredHeight);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', applyStoredHeight);
    };
  }, [active]);
}

export function AutomationDrawerResizeHandle() {
  const t = useT().agent.automations;
  const resizeWithKeyboard = useCallback((direction: 1 | -1) => {
    const drawer = drawerElement();
    if (!drawer) return;
    setDrawerHeight(
      drawer.getBoundingClientRect().height + direction * DRAWER_KEYBOARD_STEP_PX,
      true,
    );
  }, []);

  return (
    <div
      aria-label={t.resizeDrawer}
      aria-orientation="horizontal"
      className="automation-drawer-resize-handle"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        resizeWithKeyboard(event.key === 'ArrowUp' ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const drawer = event.currentTarget.closest<HTMLElement>('.automation-drawer');
        if (!drawer) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startHeight = drawer.getBoundingClientRect().height;
        const maxHeight = drawerMaxHeight(drawer);
        const move = (moveEvent: PointerEvent) => {
          setDrawerHeight(startHeight + startY - moveEvent.clientY, true);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
        setDrawerHeight(clampAutomationDrawerHeight(startHeight, maxHeight), false);
      }}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}
