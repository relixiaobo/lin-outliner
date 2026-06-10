import type { NodeId } from '../../api/types';

const ROW_MOVE_SELECTOR = '[data-node-id][data-parent-id] > .row';
const ROW_MOVE_ANCHOR_SELECTOR = '.row-leading';
const ROW_MOVE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const MIN_MOVE_PX = 0.5;

type RowRect = Pick<DOMRect, 'left' | 'top'>;

interface CapturedRowRects {
  byPath: Map<string, RowRect | null>;
  byNodeId: Map<NodeId, RowRect | null>;
}

interface RowMove {
  row: HTMLElement;
  dx: number;
  dy: number;
}

const activeAnimations = new WeakMap<HTMLElement, Animation>();

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function activeOutlinerScope(): ParentNode {
  return document.querySelector('.outline-panel-surface.active-panel.is-outliner') ?? document;
}

function parseDurationMs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const amount = Number.parseFloat(trimmed);
  if (!Number.isFinite(amount)) return 0;
  if (trimmed.endsWith('ms')) return amount;
  if (trimmed.endsWith('s')) return amount * 1000;
  return amount;
}

function rowMoveDurationMs(): number {
  return parseDurationMs(
    getComputedStyle(document.documentElement).getPropertyValue('--motion-layout-duration'),
  );
}

function rowAnchorRect(row: HTMLElement): RowRect {
  const rect = (row.querySelector<HTMLElement>(ROW_MOVE_ANCHOR_SELECTOR) ?? row).getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

function uniqueSet<K>(map: Map<K, RowRect | null>, key: K, rect: RowRect) {
  map.set(key, map.has(key) ? null : rect);
}

function rowInstancePath(row: HTMLElement): string | null {
  const wrap = row.parentElement;
  const flatKey = row.closest<HTMLElement>('[data-flat-row-key]')?.dataset.flatRowKey;
  if (!wrap) return flatKey ?? null;

  const segments: string[] = [];
  let current: HTMLElement | null = wrap;
  while (current) {
    if (current.matches('[data-node-id][data-parent-id]')) {
      segments.unshift(`${current.dataset.parentId ?? ''}/${current.dataset.nodeId ?? ''}`);
    }
    current = current.parentElement?.closest<HTMLElement>('[data-node-id][data-parent-id]') ?? null;
  }

  const path = segments.join('>');
  if (!path) return flatKey ?? null;
  return flatKey ? `${flatKey}|${path}` : path;
}

function captureVisibleRowRects(scope: ParentNode): CapturedRowRects {
  const rects: CapturedRowRects = {
    byPath: new Map(),
    byNodeId: new Map(),
  };
  scope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR).forEach((row) => {
    const nodeId = row.parentElement?.dataset.nodeId;
    const path = rowInstancePath(row);
    if (!nodeId || !path) return;
    const rect = rowAnchorRect(row);
    uniqueSet(rects.byPath, path, rect);
    uniqueSet(rects.byNodeId, nodeId, rect);
  });
  return rects;
}

function lookupPreviousRect(before: CapturedRowRects, row: HTMLElement): RowRect | null {
  const path = rowInstancePath(row);
  const pathRect = path ? before.byPath.get(path) : undefined;
  if (pathRect) return pathRect;
  const nodeId = row.parentElement?.dataset.nodeId;
  if (!nodeId) return null;
  return before.byNodeId.get(nodeId) ?? null;
}

function cancelActiveAnimation(row: HTMLElement) {
  const animation = activeAnimations.get(row);
  if (!animation) return;
  activeAnimations.delete(row);
  animation.cancel();
  row.classList.remove('row-move-animating');
}

function cancelActiveAnimations(scope: ParentNode) {
  scope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR).forEach(cancelActiveAnimation);
}

function finishAnimation(row: HTMLElement, animation: Animation) {
  if (activeAnimations.get(row) !== animation) return;
  activeAnimations.delete(row);
  row.classList.remove('row-move-animating');
}

function animateRows(moves: readonly RowMove[]) {
  const duration = rowMoveDurationMs();
  if (duration <= 0) return;

  for (const move of moves) {
    cancelActiveAnimation(move.row);
    move.row.classList.add('row-move-animating');
    const animation = move.row.animate(
      [
        { transform: `translate(${move.dx}px, ${move.dy}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration, easing: ROW_MOVE_EASING },
    );
    activeAnimations.set(move.row, animation);
    void animation.finished
      .then(() => finishAnimation(move.row, animation))
      .catch(() => finishAnimation(move.row, animation));
  }
}

function collectRowMoves(scope: ParentNode, before: CapturedRowRects): RowMove[] {
  const rows = [...scope.querySelectorAll<HTMLElement>(ROW_MOVE_SELECTOR)];
  const moves: RowMove[] = [];
  for (const row of rows) {
    const previous = lookupPreviousRect(before, row);
    if (!previous) continue;
    const next = rowAnchorRect(row);
    const dx = previous.left - next.left;
    const dy = previous.top - next.top;
    if (Math.abs(dx) < MIN_MOVE_PX && Math.abs(dy) < MIN_MOVE_PX) continue;
    moves.push({ row, dx, dy });
  }
  return moves;
}

// Capture old row positions before React commits the structural move, then invert
// rows from their previous positions on the next frame. The animation is scoped to
// the active outliner panel so mirrored panes or background surfaces do not move.
export function animateOutlinerRowMovementAfterNextCommit() {
  if (typeof window === 'undefined' || prefersReducedMotion()) return;

  const scope = activeOutlinerScope();
  const before = captureVisibleRowRects(scope);
  if (before.byPath.size === 0 && before.byNodeId.size === 0) return;
  cancelActiveAnimations(scope);

  window.requestAnimationFrame(() => {
    const afterScope = activeOutlinerScope();
    animateRows(collectRowMoves(afterScope, before));
  });
}
