import type { NodeId } from '../../api/types';

const ROW_MOVE_SELECTOR = '[data-node-id][data-parent-id] > .row';
const ROW_MOVE_ANCHOR_SELECTOR = '.row-leading';
const ROW_MOVE_ANIMATION_MS = 160;
const ROW_MOVE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const ROW_MOVE_CLEANUP_BUFFER_MS = 80;
const MIN_MOVE_PX = 0.5;

type RowRect = Pick<DOMRect, 'left' | 'top'>;

interface InlineStyleSnapshot {
  transform: string;
  transition: string;
  willChange: string;
  zIndex: string;
}

interface ActiveAnimation {
  token: number;
  snapshot: InlineStyleSnapshot;
}

const activeAnimations = new WeakMap<HTMLElement, ActiveAnimation>();

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function activeOutlinerScope(): ParentNode {
  return document.querySelector('.outline-panel-surface.active-panel.is-outliner') ?? document;
}

function captureVisibleRowRects(scope: ParentNode): Map<NodeId, RowRect> {
  const rects = new Map<NodeId, RowRect>();
  scope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR).forEach((row) => {
    const wrap = row.parentElement;
    const nodeId = wrap?.dataset.nodeId;
    if (!nodeId || rects.has(nodeId)) return;
    const rect = (row.querySelector<HTMLElement>(ROW_MOVE_ANCHOR_SELECTOR) ?? row).getBoundingClientRect();
    rects.set(nodeId, { left: rect.left, top: rect.top });
  });
  return rects;
}

function restoreInlineStyle(row: HTMLElement, snapshot: InlineStyleSnapshot) {
  row.style.transform = snapshot.transform;
  row.style.transition = snapshot.transition;
  row.style.willChange = snapshot.willChange;
  row.style.zIndex = snapshot.zIndex;
  row.classList.remove('row-move-animating');
}

function restoreActiveAnimation(row: HTMLElement) {
  const active = activeAnimations.get(row);
  if (!active) return;
  activeAnimations.delete(row);
  restoreInlineStyle(row, active.snapshot);
}

function restoreActiveAnimations(scope: ParentNode) {
  scope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR).forEach(restoreActiveAnimation);
}

function animateRowFrom(row: HTMLElement, dx: number, dy: number) {
  const token = Date.now() + Math.random();
  restoreActiveAnimation(row);

  const snapshot: InlineStyleSnapshot = {
    transform: row.style.transform,
    transition: row.style.transition,
    willChange: row.style.willChange,
    zIndex: row.style.zIndex,
  };
  activeAnimations.set(row, { token, snapshot });

  const baseTransform = snapshot.transform ? ` ${snapshot.transform}` : '';
  row.classList.add('row-move-animating');
  row.style.transition = 'none';
  row.style.transform = `translate(${dx}px, ${dy}px)${baseTransform}`;
  row.style.willChange = 'transform';
  row.style.zIndex = snapshot.zIndex || '1';
  row.getBoundingClientRect();

  window.requestAnimationFrame(() => {
    if (activeAnimations.get(row)?.token !== token) return;
    row.style.transition = `transform ${ROW_MOVE_ANIMATION_MS}ms ${ROW_MOVE_EASING}`;
    row.style.transform = snapshot.transform;
  });

  window.setTimeout(() => {
    if (activeAnimations.get(row)?.token !== token) return;
    activeAnimations.delete(row);
    restoreInlineStyle(row, snapshot);
  }, ROW_MOVE_ANIMATION_MS + ROW_MOVE_CLEANUP_BUFFER_MS);
}

// Capture old row positions before React commits the structural move, then invert
// rows from their previous positions on the next frame. The animation is scoped to
// the active outliner panel so mirrored panes or background surfaces do not move.
export function animateOutlinerRowMovementAfterNextCommit() {
  if (typeof window === 'undefined' || prefersReducedMotion()) return;

  const scope = activeOutlinerScope();
  const before = captureVisibleRowRects(scope);
  if (before.size === 0) return;
  restoreActiveAnimations(scope);

  window.requestAnimationFrame(() => {
    const afterScope = activeOutlinerScope();
    afterScope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR).forEach((row) => {
      const nodeId = row.parentElement?.dataset.nodeId;
      if (!nodeId) return;
      const previous = before.get(nodeId);
      if (!previous) return;
      const next = (row.querySelector<HTMLElement>(ROW_MOVE_ANCHOR_SELECTOR) ?? row).getBoundingClientRect();
      const dx = previous.left - next.left;
      const dy = previous.top - next.top;
      if (Math.abs(dx) < MIN_MOVE_PX && Math.abs(dy) < MIN_MOVE_PX) return;
      animateRowFrom(row, dx, dy);
    });
  });
}
