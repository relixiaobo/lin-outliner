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
  availablePanelWidth,
  clampRailWidthsForPanelFloor,
  clampRailWidthsToLimits,
  panelCountFitsAtMinimumRails,
  workspaceLayoutMetricsFromCanvas,
  type RailWidths,
  type ResponsiveRailState,
  type WorkspaceLayoutMetrics,
} from './workspaceResponsiveLayout';

const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 40;

type RailKind = 'sidebar' | 'agent';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function resizeKeyDelta(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
  if (event.key === 'ArrowLeft') return -step;
  if (event.key === 'ArrowRight') return step;
  return null;
}

function sameRailWidths(left: RailWidths, right: RailWidths) {
  return left.sidebarWidth === right.sidebarWidth && left.agentWidth === right.agentWidth;
}

function railWidthKey(kind: RailKind): keyof RailWidths {
  return kind === 'sidebar' ? 'sidebarWidth' : 'agentWidth';
}

function railMin(kind: RailKind) {
  return kind === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_AGENT_WIDTH;
}

function railMax(kind: RailKind) {
  return kind === 'sidebar' ? MAX_SIDEBAR_WIDTH : MAX_AGENT_WIDTH;
}

function railKeyboardWidth(kind: RailKind, current: number, delta: number | null, key: string) {
  if (key === 'Home') return railMin(kind);
  if (key === 'End') return railMax(kind);
  return current + (kind === 'sidebar' ? delta ?? 0 : -(delta ?? 0));
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
  const [preferredRails, setPreferredRails] = useState<RailWidths>({
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    agentWidth: DEFAULT_AGENT_WIDTH,
  });
  const [renderedRails, setRenderedRails] = useState<RailWidths>(preferredRails);
  const canvasRef = useRef<HTMLElement | null>(null);
  const preferredRailsRef = useRef(preferredRails);
  const renderedRailsRef = useRef(renderedRails);
  const railOpenRef = useRef({ sidebarOpen, agentOpen });
  const panelCount = Math.max(1, panels.length);
  const panelCountRef = useRef(panelCount);

  preferredRailsRef.current = preferredRails;
  renderedRailsRef.current = renderedRails;
  railOpenRef.current = { sidebarOpen, agentOpen };
  panelCountRef.current = panelCount;

  const railStateFrom = useCallback((widths: RailWidths): ResponsiveRailState => ({
    ...widths,
    sidebarOpen: railOpenRef.current.sidebarOpen,
    agentOpen: railOpenRef.current.agentOpen,
  }), []);

  const renderedRailState = useCallback(() => railStateFrom(renderedRailsRef.current), [railStateFrom]);

  const commitPreferredRails = useCallback((next: RailWidths) => {
    const clamped = clampRailWidthsToLimits(next);
    preferredRailsRef.current = clamped;
    setPreferredRails((prev) => (sameRailWidths(prev, clamped) ? prev : clamped));
    return clamped;
  }, []);

  const commitRenderedRails = useCallback((next: RailWidths) => {
    renderedRailsRef.current = next;
    setRenderedRails((prev) => (sameRailWidths(prev, next) ? prev : next));
  }, []);

  const renderedRailsForPreference = useCallback((
    preference: RailWidths,
    nextPanelCount: number,
    metrics?: WorkspaceLayoutMetrics,
  ) => {
    const canvas = canvasRef.current;
    const resolvedMetrics = metrics ?? (canvas ? workspaceLayoutMetricsFromCanvas(canvas) : null);
    if (!resolvedMetrics) return clampRailWidthsToLimits(preference);
    return clampRailWidthsForPanelFloor(
      resolvedMetrics,
      railStateFrom(preference),
      Math.max(1, nextPanelCount),
    );
  }, [railStateFrom]);

  const applyRailPreference = useCallback((
    nextPreference: RailWidths,
    options: { metrics?: WorkspaceLayoutMetrics; panelCount?: number } = {},
  ) => {
    const clampedPreference = commitPreferredRails(nextPreference);
    commitRenderedRails(renderedRailsForPreference(
      clampedPreference,
      options.panelCount ?? panelCountRef.current,
      options.metrics,
    ));
  }, [commitPreferredRails, commitRenderedRails, renderedRailsForPreference]);

  const panelCountFitsCapacity = useCallback((nextPanelCount: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return true;
    return panelCountFitsAtMinimumRails(
      workspaceLayoutMetricsFromCanvas(canvas),
      railStateFrom(preferredRailsRef.current),
      Math.max(1, nextPanelCount),
    );
  }, [railStateFrom]);

  const reflowRailsForPanelCount = useCallback((nextPanelCount = panelCountRef.current) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      commitRenderedRails(preferredRailsRef.current);
      return true;
    }
    const metrics = workspaceLayoutMetricsFromCanvas(canvas);
    const rails = railStateFrom(preferredRailsRef.current);
    const clampedPanelCount = Math.max(1, nextPanelCount);
    commitRenderedRails(clampRailWidthsForPanelFloor(metrics, rails, clampedPanelCount));
    return panelCountFitsAtMinimumRails(metrics, rails, clampedPanelCount);
  }, [commitRenderedRails, railStateFrom]);

  useLayoutEffect(() => {
    let frame = 0;
    const scheduleReflow = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        reflowRailsForPanelCount();
      });
    };

    scheduleReflow();
    window.addEventListener('resize', scheduleReflow);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleReflow);
    };
  }, [reflowRailsForPanelCount]);

  useLayoutEffect(() => {
    reflowRailsForPanelCount(panelCount);
  }, [agentOpen, panelCount, reflowRailsForPanelCount, sidebarOpen]);

  const beginRailResize = useCallback((kind: RailKind, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const key = railWidthKey(kind);
    const startPreference = { ...preferredRailsRef.current };
    const startWidth = startPreference[key];
    const canvas = canvasRef.current;
    const metrics = canvas ? workspaceLayoutMetricsFromCanvas(canvas) : undefined;
    const panelCountAtStart = panelCountRef.current;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = kind === 'sidebar'
        ? moveEvent.clientX - startX
        : startX - moveEvent.clientX;
      applyRailPreference({
        ...startPreference,
        [key]: startWidth + delta,
      }, { metrics, panelCount: panelCountAtStart });
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
  }, [applyRailPreference]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    beginRailResize('sidebar', event);
  }, [beginRailResize]);

  const resetSidebarWidth = useCallback(() => {
    applyRailPreference({
      ...preferredRailsRef.current,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    });
  }, [applyRailPreference]);

  const resizeRailWithKeyboard = useCallback((
    kind: RailKind,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const delta = resizeKeyDelta(event);
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    const key = railWidthKey(kind);
    applyRailPreference({
      ...preferredRailsRef.current,
      [key]: railKeyboardWidth(kind, preferredRailsRef.current[key], delta, event.key),
    });
  }, [applyRailPreference]);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    resizeRailWithKeyboard('sidebar', event);
  }, [resizeRailWithKeyboard]);

  const beginAgentResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    beginRailResize('agent', event);
  }, [beginRailResize]);

  const resetAgentWidth = useCallback(() => {
    applyRailPreference({
      ...preferredRailsRef.current,
      agentWidth: DEFAULT_AGENT_WIDTH,
    });
  }, [applyRailPreference]);

  const resizeAgentWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    resizeRailWithKeyboard('agent', event);
  }, [resizeRailWithKeyboard]);

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
      availablePanelWidth(metrics, renderedRailState())
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
  }, [panels, renderedRailState, resizePanelPair]);

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

    const metrics = workspaceLayoutMetricsFromCanvas(canvas);
    const sizeOf = (panelId: string) => panels.find((panel) => panel.id === panelId)?.size ?? 1;
    const totalSize = panels.reduce((sum, panel) => sum + panel.size, 0);
    const usableWidth = Math.max(
      1,
      availablePanelWidth(metrics, renderedRailState())
        - Math.max(0, panels.length - 1) * metrics.panelGap,
    );
    const sizePerPixel = totalSize / usableWidth;
    const leftStart = sizeOf(leftPanelId);
    const rightStart = sizeOf(rightPanelId);
    const pairTotal = leftStart + rightStart;
    const minPanelSize = Math.min(pairTotal / 2, metrics.panelMinWidth * sizePerPixel);
    const startX = event.clientX;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-layout');

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaSize = (moveEvent.clientX - startX) * sizePerPixel;
      const nextLeft = clamp(leftStart + deltaSize, minPanelSize, pairTotal - minPanelSize);
      resizePanelPair(leftPanelId, rightPanelId, nextLeft, pairTotal - nextLeft);
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
  }, [panels, renderedRailState, resizePanelPair]);

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
    agentWidth: renderedRails.agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    panelCountFitsCapacity,
    reflowRailsForPanelCount,
    resetAgentWidth,
    resetPanelPair,
    resetSidebarWidth,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth: renderedRails.sidebarWidth,
  };
}
