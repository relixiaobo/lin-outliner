import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react';
import {
  AWAKE_MARK_MOODS,
  markMoodParams,
  mixMarkParams,
  renderMarkEye,
  type MarkEyeParams,
  type MarkMood,
} from '../agentMarkGeometry';

/**
 * The mark every agent wears: one soft form in the participant's identity
 * colour, with two round-capped eye strokes cut straight through to the panel.
 *
 * The eyes are HOLES in a mask, not painted pupils — they show whatever is
 * behind the mark, so a mark has exactly one colour and the eyes can never be
 * mis-paired against a theme. No ground, no crop, no frame: the form is its
 * own edge.
 *
 * The eyes CARRY STATE and FOLLOW ATTENTION. A mood is a parameter set over
 * one stroke rig (`agentMarkGeometry`), so expressions morph rather than swap;
 * the pose lives on a sphere, so a turned head narrows the far eye the way a
 * ball does; and everything animated runs through one module-wide rAF loop
 * driven by refs — a transcript of marks never re-renders to move an eye (A9).
 * `prefers-reduced-motion` gets the mood's static shape and nothing moving.
 */

export interface AgentMarkHandle {
  /** Aim the gaze: offsets normalized to mark-widths from the mark's centre. */
  setPointer(dx: number, dy: number): void;
  clearPointer(): void;
}

interface LiveMark {
  readonly eyes: readonly [SVGPathElement, SVGPathElement];
  readonly groups: readonly [SVGGElement, SVGGElement];
  cur: MarkEyeParams; tgt: MarkEyeParams;
  yaw: number; pitch: number; tgtYaw: number; tgtPitch: number;
  mood: MarkMood;
  pointer: { x: number; y: number } | null;
  scanX: number; scanAt: number;
  /** Which eyes the current blink closes; empty between blinks. */
  blinking: readonly (0 | 1)[];
  blinkStart: number; blinkAt: number;
  /** Off-screen marks hold still: paint nobody sees is paint wasted (A9). */
  visible: boolean;
}

// A blink is fast to shut and unhurried to open — equal speeds in both
// directions are the tell of a machine. Milliseconds live here, in script,
// because CSS motion must come from the `--motion-*` tokens (B1/B11) and no
// token pairs a 55ms close with a 150ms open.
const BLINK_SHUT_MS = 55, BLINK_HOLD_MS = 40, BLINK_OPEN_MS = 150;
const BLINK_MIN_GAP_MS = 2600, BLINK_JITTER_MS = 4600;

function blinkOpenness(elapsed: number): number {
  if (elapsed < BLINK_SHUT_MS) return 1 - (elapsed / BLINK_SHUT_MS) ** 2;
  if (elapsed < BLINK_SHUT_MS + BLINK_HOLD_MS) return 0;
  const opening = (elapsed - BLINK_SHUT_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
  return opening >= 1 ? 1 : 1 - (1 - opening) ** 2;
}

// ── the coordinator ──────────────────────────────────────────────────────────
// One rAF loop for every live mark on the page. A mark participates only while
// something is actually moving — an unsettled tween, a pursued pointer, or a
// working scan — and the loop stops entirely when the set empties.
const live = new Set<LiveMark>();
let raf = 0, last = 0;
// A scheduler that calls back SYNCHRONOUSLY — a test shim, a polyfill — would
// otherwise re-enter this frame from inside itself and recurse without bound.
// Real rAF is always async, so the guard costs production nothing and turns a
// stack overflow into "one frame, then still".
let inStep = false;

function apply(mark: LiveMark, openness: readonly [number, number] = [1, 1]): void {
  for (const [index, sign] of [[0, -1], [1, 1]] as const) {
    const eye = renderMarkEye(
      { ...mark.cur, openness: mark.cur.openness * openness[index]! },
      mark.yaw, mark.pitch, sign,
    );
    const path = mark.eyes[index], group = mark.groups[index];
    path.setAttribute('d', eye.d);
    path.setAttribute('stroke-width', eye.width.toFixed(2));
    group.style.transformOrigin = `${eye.originX.toFixed(2)}px ${eye.originY.toFixed(2)}px`;
  }
}

function snapshot(mark: LiveMark): string {
  return `${mark.cur.u1.toFixed(3)},${mark.cur.v1.toFixed(3)},${mark.cur.uc.toFixed(3)},${mark.cur.vc.toFixed(3)},${mark.cur.u2.toFixed(3)},${mark.cur.v2.toFixed(3)},${mark.cur.w.toFixed(3)},${mark.cur.look.toFixed(3)},${mark.cur.grow.toFixed(3)},${mark.yaw.toFixed(3)},${mark.pitch.toFixed(3)}`;
}

function step(ts: number): void {
  if (inStep) return;
  inStep = true;
  try {
    stepFrame(ts);
  } finally {
    inStep = false;
  }
}

function stepFrame(ts: number): void {
  const dt = Math.min(50, ts - (last || ts)); last = ts;
  const kMood = 1 - Math.exp(-dt / 110);   // expressions settle quickly
  const kPose = 1 - Math.exp(-dt / 150);   // the head has more mass
  for (const mark of live) {
    // Behaviour → targets. A pursued pointer wins; Working reads line by line;
    // otherwise the head returns to rest.
    if (mark.pointer) {
      mark.tgtYaw = Math.max(-1, Math.min(1, mark.pointer.x)) * .34;
      mark.tgtPitch = Math.max(-1, Math.min(1, mark.pointer.y)) * .24;
    } else if (mark.mood === 'working') {
      if (ts > mark.scanAt) {
        mark.scanX += .45; if (mark.scanX > 1) mark.scanX = -1;
        mark.scanAt = ts + (mark.scanX === -1 ? 260 : 420 + Math.random() * 360);
      }
      mark.tgtYaw = mark.scanX * .22; mark.tgtPitch = .1;
    } else {
      mark.tgtYaw = 0; mark.tgtPitch = 0;
    }
    // Blinking, scheduled per mark: mostly both eyes, now and then just one.
    // Closed-eye moods do not blink — a sleeping face that blinks is worse
    // than one that never does.
    let openness: [number, number] = [1, 1];
    if (mark.blinking.length > 0) {
      const elapsed = ts - mark.blinkStart;
      if (elapsed > BLINK_SHUT_MS + BLINK_HOLD_MS + BLINK_OPEN_MS) {
        mark.blinking = [];
        mark.blinkAt = ts + BLINK_MIN_GAP_MS + Math.random() * BLINK_JITTER_MS;
      } else {
        const factor = blinkOpenness(elapsed);
        for (const eye of mark.blinking) openness[eye] = factor;
      }
    } else if (ts >= mark.blinkAt && AWAKE_MARK_MOODS.includes(mark.mood)) {
      mark.blinking = Math.random() < 0.16 ? [Math.random() < 0.5 ? 0 : 1] : [0, 1];
      mark.blinkStart = ts;
    } else if (ts >= mark.blinkAt) {
      mark.blinkAt = ts + BLINK_MIN_GAP_MS + Math.random() * BLINK_JITTER_MS;
    }
    const before = snapshot(mark);
    mark.cur = mixMarkParams(mark.cur, mark.tgt, kMood);
    mark.yaw += (mark.tgtYaw - mark.yaw) * kPose;
    mark.pitch += (mark.tgtPitch - mark.pitch) * kPose;
    apply(mark, openness);
    const settled = mark.pointer === null && mark.mood !== 'working'
      && mark.blinking.length === 0 && before === snapshot(mark);
    // A settled mark leaves the loop but keeps its place in the blink
    // schedule; the timer that wakes it is the only thing still running.
    if (settled) {
      live.delete(mark);
      if (mark.visible && AWAKE_MARK_MOODS.includes(mark.mood)) scheduleWake(mark);
    }
  }
  raf = live.size > 0 ? requestAnimationFrame(step) : 0;
  if (raf === 0) last = 0;
}

function wake(mark: LiveMark): void {
  const timer = wakeTimers.get(mark);
  if (timer !== undefined) { clearTimeout(timer); wakeTimers.delete(mark); }
  live.add(mark);
  if (raf === 0 && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(step);
}

/**
 * Sleep until this mark's next blink is due, then rejoin the loop. Between
 * blinks a still mark costs one pending timer and nothing else — no rAF, no
 * paint — which is what lets a transcript hold fifty of them.
 */
const wakeTimers = new WeakMap<LiveMark, ReturnType<typeof setTimeout>>();
function scheduleWake(mark: LiveMark): void {
  if (wakeTimers.has(mark)) return;
  const delay = Math.max(16, mark.blinkAt - (typeof performance === 'object' ? performance.now() : 0));
  wakeTimers.set(mark, setTimeout(() => {
    wakeTimers.delete(mark);
    if (mark.visible) wake(mark);
  }, delay));
}

export function stopMark(mark: LiveMark): void {
  live.delete(mark);
  const timer = wakeTimers.get(mark);
  if (timer !== undefined) { clearTimeout(timer); wakeTimers.delete(mark); }
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const AgentMark = forwardRef<AgentMarkHandle, {
  /** The `--identity-tint-<n>` index the mark is filled with. */
  readonly tint: number;
  readonly size: number;
  /** The state the eyes express; expressions morph on change. */
  readonly mood?: MarkMood;
}>(function AgentMark({ tint, size, mood = 'idle' }, handle) {
  const maskId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const markRef = useRef<LiveMark | null>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;

  // Build the live-mark record once the SVG exists; mood changes are applied
  // by the effect below without rebuilding.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const groups = [...svg.querySelectorAll<SVGGElement>('.agent-mark-eye')];
    const eyes = groups.map((g) => g.querySelector('path')).filter((p): p is SVGPathElement => p !== null);
    if (groups.length !== 2 || eyes.length !== 2) return;
    const params = markMoodParams(moodRef.current);
    const mark: LiveMark = {
      eyes: [eyes[0]!, eyes[1]!], groups: [groups[0]!, groups[1]!],
      cur: params, tgt: params,
      yaw: 0, pitch: 0, tgtYaw: 0, tgtPitch: 0,
      mood: moodRef.current, pointer: null, scanX: -1, scanAt: 0,
      blinking: [], blinkStart: 0,
      blinkAt: (typeof performance === 'object' ? performance.now() : 0)
        + 600 + Math.random() * 3400,
      visible: true,
    };
    markRef.current = mark;
    apply(mark);
    if (reducedMotion()) return () => { stopMark(mark); markRef.current = null; };

    // Only marks the reader can actually see animate. A transcript scrolled
    // back holds dozens; blinking them all drives paint on rows nobody is
    // looking at, and on a backgrounded window that is pure waste.
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(([entry]) => {
        mark.visible = entry?.isIntersecting ?? true;
        if (mark.visible) wake(mark); else stopMark(mark);
      });
      observer.observe(svg);
    } else {
      wake(mark);
    }
    return () => { observer?.disconnect(); stopMark(mark); markRef.current = null; };
  }, []);

  // Mood transitions morph through the shared loop; under reduced motion the
  // new shape lands immediately, expression preserved without movement.
  useEffect(() => {
    const mark = markRef.current;
    if (!mark || mark.mood === mood) return;
    mark.mood = mood;
    mark.tgt = markMoodParams(mood);
    if (reducedMotion()) {
      mark.cur = mark.tgt; mark.yaw = 0; mark.pitch = 0;
      apply(mark);
      return;
    }
    wake(mark);
  }, [mood]);

  useImperativeHandle(handle, () => ({
    setPointer(dx, dy) {
      const mark = markRef.current;
      if (!mark || reducedMotion()) return;
      mark.pointer = { x: dx, y: dy };
      wake(mark);
    },
    clearPointer() {
      const mark = markRef.current;
      if (!mark || mark.pointer === null) return;
      mark.pointer = null;
      if (!reducedMotion()) wake(mark);
    },
  }), []);


  // First paint carries the mood's static geometry, so a mark is correct
  // before any effect runs (and permanently correct under reduced motion).
  const initial = ([-1, 1] as const).map((sign) => renderMarkEye(markMoodParams(mood), 0, 0, sign));
  return (
    <svg
      aria-hidden
      data-mood={mood}
      height={size}
      ref={svgRef}
      viewBox="0 0 32 32"
      width={size}
    >
      <defs>
        {/* Mask luminance, not on-screen colour: white keeps, black cuts. Kept
            as attributes so the stylesheet stays hex-free (B1 guard). */}
        <mask id={maskId}>
          <rect fill="#fff" height="32" width="32" />
          {initial.map((eye, index) => (
            <g
              className="agent-mark-eye"
              key={index}
              style={{ transformOrigin: `${eye.originX}px ${eye.originY}px` }}
            >
              <path d={eye.d} fill="none" stroke="#000" strokeLinecap="round" strokeWidth={eye.width} />
            </g>
          ))}
        </mask>
      </defs>
      <path
        d="M16 3.2 C23.6 3.2 28.8 8.4 28.8 16 C28.8 23.6 23.6 28.8 16 28.8 C8.4 28.8 3.2 23.6 3.2 16 C3.2 8.4 8.4 3.2 16 3.2 Z"
        fill={`var(--identity-tint-${tint})`}
        mask={`url(#${maskId})`}
      />
    </svg>
  );
});
