import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';

const DEFAULT_SIDEBAR_WIDTH = 196;
const DEFAULT_AGENT_WIDTH = 344;
const MIN_SIDEBAR_WIDTH = 152;
const MAX_SIDEBAR_WIDTH = 280;
const MIN_AGENT_WIDTH = 280;
const MAX_AGENT_WIDTH = 520;
const FALLBACK_PANEL_MIN_WIDTH = 360;
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 40;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function panelGapPx(canvas: HTMLElement) {
  const raw = getComputedStyle(canvas).getPropertyValue('--panel-gap');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function panelMinWidthPx(canvas: HTMLElement) {
  const raw = getComputedStyle(canvas).getPropertyValue('--outline-panel-min-width');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : FALLBACK_PANEL_MIN_WIDTH;
}

function resizeKeyDelta(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
  if (event.key === 'ArrowLeft') return -step;
  if (event.key === 'ArrowRight') return step;
  return null;
}

interface UseResizableLayoutOptions {
  panels: WorkspacePanelState[];
  resizePanelPair: (
    leftPanelId: string,
    rightPanelId: string,
    leftSize: number,
    rightSize: number,
  ) => void;
}

export function useResizableLayout({ panels, resizePanelPair }: UseResizableLayoutOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [agentWidth, setAgentWidth] = useState(DEFAULT_AGENT_WIDTH);
  const canvasRef = useRef<HTMLElement | null>(null);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clamp(startWidth + moveEvent.clientX - startX, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
    };
    const endResize = () => {
      handle.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-layout');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }, [sidebarWidth]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }, []);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = resizeKeyDelta(event);
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
      return;
    }
    if (event.key === 'End') {
      setSidebarWidth(MAX_SIDEBAR_WIDTH);
      return;
    }
    setSidebarWidth((width) => clamp(width + (delta ?? 0), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  }, []);

  const beginAgentResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = agentWidth;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      setAgentWidth(clamp(startWidth - (moveEvent.clientX - startX), MIN_AGENT_WIDTH, MAX_AGENT_WIDTH));
    };
    const endResize = () => {
      handle.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-layout');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }, [agentWidth]);

  const resetAgentWidth = useCallback(() => {
    setAgentWidth(DEFAULT_AGENT_WIDTH);
  }, []);

  const resizeAgentWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = resizeKeyDelta(event);
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      setAgentWidth(MIN_AGENT_WIDTH);
      return;
    }
    if (event.key === 'End') {
      setAgentWidth(MAX_AGENT_WIDTH);
      return;
    }
    setAgentWidth((width) => clamp(width - (delta ?? 0), MIN_AGENT_WIDTH, MAX_AGENT_WIDTH));
  }, []);

  const resizePanelPairByPixels = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    deltaPixels: number,
  ) => {
    const canvas = canvasRef.current;
    if (panels.length === 0 || !canvas) return;

    const sizeOf = (panelId: string) => panels.find((panel) => panel.id === panelId)?.size ?? 1;
    const totalSize = panels.reduce((sum, panel) => sum + panel.size, 0);
    const usableWidth = Math.max(
      1,
      canvas.getBoundingClientRect().width - Math.max(0, panels.length - 1) * panelGapPx(canvas),
    );
    const sizePerPixel = totalSize / usableWidth;
    const leftStart = sizeOf(leftPanelId);
    const rightStart = sizeOf(rightPanelId);
    const pairTotal = leftStart + rightStart;
    const minPanelSize = Math.min(pairTotal / 2, panelMinWidthPx(canvas) * sizePerPixel);
    const deltaSize = deltaPixels * sizePerPixel;
    const nextLeft = clamp(leftStart + deltaSize, minPanelSize, pairTotal - minPanelSize);
    const nextRight = pairTotal - nextLeft;
    resizePanelPair(leftPanelId, rightPanelId, nextLeft, nextRight);
  }, [panels, resizePanelPair]);

  const beginPanelResize = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const canvas = canvasRef.current;
    if (panels.length === 0 || !canvas) return;

    const startX = event.clientX;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      resizePanelPairByPixels(leftPanelId, rightPanelId, moveEvent.clientX - startX);
    };
    const endResize = () => {
      handle.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-layout');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }, [panels.length, resizePanelPairByPixels]);

  const resetPanelPair = useCallback((leftPanelId: string, rightPanelId: string) => {
    if (panels.length === 0) return;
    const sizeOf = (panelId: string) => panels.find((panel) => panel.id === panelId)?.size ?? 1;
    const half = (sizeOf(leftPanelId) + sizeOf(rightPanelId)) / 2;
    resizePanelPair(leftPanelId, rightPanelId, half, half);
  }, [panels, resizePanelPair]);

  const resizePanelPairWithKeyboard = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const delta = resizeKeyDelta(event);
    if (delta === null) return;
    event.preventDefault();
    event.stopPropagation();
    resizePanelPairByPixels(leftPanelId, rightPanelId, delta);
  }, [resizePanelPairByPixels]);

  return {
    agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    resetAgentWidth,
    resetPanelPair,
    resetSidebarWidth,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth,
  };
}
