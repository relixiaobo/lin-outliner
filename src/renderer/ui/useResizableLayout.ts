import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';
import {
  DEFAULT_AGENT_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_AGENT_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_AGENT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampRailWidthForPanelFloor,
  clampRailWidthsForPanelFloor,
  availablePanelWidth,
  panelCountFitsAtMinimumRails,
  workspaceLayoutMetricsFromCanvas,
  type ResponsiveRailState,
} from './workspaceResponsiveLayout';

const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 40;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function resizeKeyDelta(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
  if (event.key === 'ArrowLeft') return -step;
  if (event.key === 'ArrowRight') return step;
  return null;
}

interface UseResizableLayoutOptions {
  agentOpen: boolean;
  panels: WorkspacePanelState[];
  resizePanelPair: (
    leftPanelId: string,
    rightPanelId: string,
    leftSize: number,
    rightSize: number,
  ) => void;
  sidebarOpen: boolean;
}

export function useResizableLayout({
  agentOpen,
  panels,
  resizePanelPair,
  sidebarOpen,
}: UseResizableLayoutOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [agentWidth, setAgentWidth] = useState(DEFAULT_AGENT_WIDTH);
  const canvasRef = useRef<HTMLElement | null>(null);
  const panelCount = Math.max(1, panels.length);

  const railState = useCallback((overrides: Partial<ResponsiveRailState> = {}): ResponsiveRailState => ({
    sidebarWidth,
    agentWidth,
    sidebarOpen,
    agentOpen,
    ...overrides,
  }), [agentOpen, agentWidth, sidebarOpen, sidebarWidth]);

  const clampSidebarWidth = useCallback((width: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return clamp(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    return clampRailWidthForPanelFloor(
      workspaceLayoutMetricsFromCanvas(canvas),
      railState({ sidebarWidth: width }),
      'sidebar',
      width,
      panelCount,
    );
  }, [panelCount, railState]);

  const clampAgentWidth = useCallback((width: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return clamp(width, MIN_AGENT_WIDTH, MAX_AGENT_WIDTH);
    return clampRailWidthForPanelFloor(
      workspaceLayoutMetricsFromCanvas(canvas),
      railState({ agentWidth: width }),
      'agent',
      width,
      panelCount,
    );
  }, [panelCount, railState]);

  const clampRailsToPanelFloor = useCallback((nextPanelCount = panelCount) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = clampRailWidthsForPanelFloor(
      workspaceLayoutMetricsFromCanvas(canvas),
      railState(),
      Math.max(1, nextPanelCount),
    );
    if (next.sidebarWidth !== sidebarWidth) setSidebarWidth(next.sidebarWidth);
    if (next.agentWidth !== agentWidth) setAgentWidth(next.agentWidth);
  }, [agentWidth, panelCount, railState, sidebarWidth]);

  const ensurePanelCapacity = useCallback((nextPanelCount: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return true;
    const metrics = workspaceLayoutMetricsFromCanvas(canvas);
    const rails = railState();
    const clampedPanelCount = Math.max(1, nextPanelCount);
    if (!panelCountFitsAtMinimumRails(metrics, rails, clampedPanelCount)) return false;
    const next = clampRailWidthsForPanelFloor(metrics, rails, clampedPanelCount);
    if (next.sidebarWidth !== sidebarWidth) setSidebarWidth(next.sidebarWidth);
    if (next.agentWidth !== agentWidth) setAgentWidth(next.agentWidth);
    return true;
  }, [agentWidth, railState, sidebarWidth]);

  useLayoutEffect(() => {
    let frame = 0;
    const scheduleClamp = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        clampRailsToPanelFloor();
      });
    };

    scheduleClamp();
    window.addEventListener('resize', scheduleClamp);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleClamp);
    };
  }, [clampRailsToPanelFloor]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
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
  }, [clampSidebarWidth, sidebarWidth]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH));
  }, [clampSidebarWidth]);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = resizeKeyDelta(event);
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      setSidebarWidth(clampSidebarWidth(MIN_SIDEBAR_WIDTH));
      return;
    }
    if (event.key === 'End') {
      setSidebarWidth(clampSidebarWidth(MAX_SIDEBAR_WIDTH));
      return;
    }
    setSidebarWidth((width) => clampSidebarWidth(width + (delta ?? 0)));
  }, [clampSidebarWidth]);

  const beginAgentResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = agentWidth;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      setAgentWidth(clampAgentWidth(startWidth - (moveEvent.clientX - startX)));
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
  }, [agentWidth, clampAgentWidth]);

  const resetAgentWidth = useCallback(() => {
    setAgentWidth(clampAgentWidth(DEFAULT_AGENT_WIDTH));
  }, [clampAgentWidth]);

  const resizeAgentWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = resizeKeyDelta(event);
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      setAgentWidth(clampAgentWidth(MIN_AGENT_WIDTH));
      return;
    }
    if (event.key === 'End') {
      setAgentWidth(clampAgentWidth(MAX_AGENT_WIDTH));
      return;
    }
    setAgentWidth((width) => clampAgentWidth(width - (delta ?? 0)));
  }, [clampAgentWidth]);

  const resizePanelPairByPixels = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    deltaPixels: number,
  ) => {
    const canvas = canvasRef.current;
    if (panels.length === 0 || !canvas) return;

    const metrics = workspaceLayoutMetricsFromCanvas(canvas);
    const sizeOf = (panelId: string) => panels.find((panel) => panel.id === panelId)?.size ?? 1;
    const totalSize = panels.reduce((sum, panel) => sum + panel.size, 0);
    const usableWidth = Math.max(
      1,
      availablePanelWidth(metrics, railState())
        - Math.max(0, panels.length - 1) * metrics.panelGap,
    );
    const sizePerPixel = totalSize / usableWidth;
    const leftStart = sizeOf(leftPanelId);
    const rightStart = sizeOf(rightPanelId);
    const pairTotal = leftStart + rightStart;
    const minPanelSize = Math.min(pairTotal / 2, metrics.panelMinWidth * sizePerPixel);
    const deltaSize = deltaPixels * sizePerPixel;
    const nextLeft = clamp(leftStart + deltaSize, minPanelSize, pairTotal - minPanelSize);
    const nextRight = pairTotal - nextLeft;
    resizePanelPair(leftPanelId, rightPanelId, nextLeft, nextRight);
  }, [panels, railState, resizePanelPair]);

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
    ensurePanelCapacity,
    resetAgentWidth,
    resetPanelPair,
    resetSidebarWidth,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth,
  };
}
