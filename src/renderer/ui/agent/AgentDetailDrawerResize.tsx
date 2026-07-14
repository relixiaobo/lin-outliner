import { useCallback, useLayoutEffect } from 'react';
import { localStorageOrNull } from '../../state/localStorageStore';
import { useT } from '../../i18n/I18nProvider';

const DRAWER_HEIGHT_RATIO_STORAGE_KEY = 'lin:agent-run-detail-drawer-height-ratio';
const DRAWER_DEFAULT_HEIGHT_RATIO = 0.8;
const DRAWER_MIN_HEIGHT_PX = 360;
const DRAWER_TOP_GAP_PX = 52;
const DRAWER_KEYBOARD_STEP_PX = 48;

function clampDrawerHeight(height: number, maxHeight: number): number {
  return Math.min(Math.max(height, DRAWER_MIN_HEIGHT_PX), Math.max(DRAWER_MIN_HEIGHT_PX, maxHeight));
}

function clampDrawerHeightRatio(ratio: number): number {
  return Math.min(Math.max(ratio, 0), 1);
}

function drawerMaxHeight(drawer: HTMLElement): number {
  const backdrop = drawer.parentElement;
  const availableHeight = backdrop?.getBoundingClientRect().height ?? 0;
  return Math.max(DRAWER_MIN_HEIGHT_PX, availableHeight - DRAWER_TOP_GAP_PX);
}

function readDrawerHeightRatio(): number {
  const storage = localStorageOrNull();
  const raw = storage?.getItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY);
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? clampDrawerHeightRatio(parsed) : DRAWER_DEFAULT_HEIGHT_RATIO;
}

function writeDrawerHeightRatio(height: number, maxHeight: number) {
  const storage = localStorageOrNull();
  if (!storage || maxHeight <= 0) return;
  try {
    storage.setItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY, clampDrawerHeightRatio(height / maxHeight).toFixed(4));
  } catch {
    // Best-effort renderer preference.
  }
}

function detailDrawerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.agent-run-detail-drawer');
}

function setDetailDrawerHeight(height: number, persist: boolean) {
  const drawer = detailDrawerElement();
  if (!drawer) return;
  const maxHeight = drawerMaxHeight(drawer);
  const nextHeight = clampDrawerHeight(height, maxHeight);
  drawer.style.setProperty('--agent-run-detail-drawer-height', `${nextHeight}px`);
  if (persist) writeDrawerHeightRatio(nextHeight, maxHeight);
}

function applyStoredDetailDrawerHeight() {
  const drawer = detailDrawerElement();
  if (!drawer) return;
  const maxHeight = drawerMaxHeight(drawer);
  setDetailDrawerHeight(maxHeight * readDrawerHeightRatio(), false);
}

export function useAgentDetailDrawerHeight(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    applyStoredDetailDrawerHeight();
    const deferredApply = typeof window.requestAnimationFrame === 'function'
      ? { kind: 'frame' as const, id: window.requestAnimationFrame(applyStoredDetailDrawerHeight) }
      : { kind: 'timeout' as const, id: window.setTimeout(applyStoredDetailDrawerHeight, 0) };
    window.addEventListener('resize', applyStoredDetailDrawerHeight);
    return () => {
      if (deferredApply.kind === 'frame' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(deferredApply.id);
      } else {
        window.clearTimeout(deferredApply.id);
      }
      window.removeEventListener('resize', applyStoredDetailDrawerHeight);
    };
  }, [active]);
}

export function AgentDetailDrawerResizeHandle() {
  const t = useT();

  const updateFromKeyboard = useCallback((direction: 1 | -1) => {
    const drawer = detailDrawerElement();
    if (!drawer) return;
    setDetailDrawerHeight(drawer.getBoundingClientRect().height + (direction * DRAWER_KEYBOARD_STEP_PX), true);
  }, []);

  return (
    <div
      aria-label={t.agent.runDetail.resizeDrawer}
      aria-orientation="horizontal"
      className="agent-run-detail-resize-handle"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        updateFromKeyboard(event.key === 'ArrowUp' ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const drawer = event.currentTarget.closest<HTMLElement>('.agent-run-detail-drawer');
        const backdrop = drawer?.parentElement;
        if (!drawer || !backdrop) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startHeight = drawer.getBoundingClientRect().height;
        const maxHeight = backdrop.getBoundingClientRect().height - DRAWER_TOP_GAP_PX;

        const move = (moveEvent: PointerEvent) => {
          setDetailDrawerHeight(clampDrawerHeight(startHeight + startY - moveEvent.clientY, maxHeight), true);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
      }}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}
