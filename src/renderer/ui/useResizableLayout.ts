import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { WorkspaceTabState } from './workspaceLayoutTypes';

const DEFAULT_SIDEBAR_WIDTH = 196;
const DEFAULT_AGENT_WIDTH = 344;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 360;
const MIN_AGENT_WIDTH = 280;
const MAX_AGENT_WIDTH = 560;
const MIN_PANEL_SIZE = 0.24;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function panelGapPx(canvas: HTMLElement) {
  const raw = getComputedStyle(canvas).getPropertyValue('--panel-gap');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface UseResizableLayoutOptions {
  activeTab: WorkspaceTabState | null;
  resizePanelPair: (
    tabId: string,
    leftPanelId: string,
    rightPanelId: string,
    leftSize: number,
    rightSize: number,
  ) => void;
}

export function useResizableLayout({ activeTab, resizePanelPair }: UseResizableLayoutOptions) {
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

  const beginPanelResize = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const tab = activeTab;
    const canvas = canvasRef.current;
    if (!tab || !canvas) return;

    const startX = event.clientX;
    const startSizes = { ...tab.panelSizes };
    const totalSize = tab.panels.reduce((sum, panel) => sum + (startSizes[panel.id] ?? 1), 0);
    const usableWidth = Math.max(
      1,
      canvas.getBoundingClientRect().width - Math.max(0, tab.panels.length - 1) * panelGapPx(canvas),
    );
    const sizePerPixel = totalSize / usableWidth;
    const leftStart = startSizes[leftPanelId] ?? 1;
    const rightStart = startSizes[rightPanelId] ?? 1;
    const pairTotal = leftStart + rightStart;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaSize = (moveEvent.clientX - startX) * sizePerPixel;
      const nextLeft = clamp(leftStart + deltaSize, MIN_PANEL_SIZE, pairTotal - MIN_PANEL_SIZE);
      const nextRight = pairTotal - nextLeft;
      resizePanelPair(tab.id, leftPanelId, rightPanelId, nextLeft, nextRight);
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
  }, [activeTab, resizePanelPair]);

  return {
    agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    sidebarWidth,
  };
}
