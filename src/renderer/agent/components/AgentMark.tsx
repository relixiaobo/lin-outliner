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
}

// ── the coordinator ──────────────────────────────────────────────────────────
// One rAF loop for every live mark on the page. A mark participates only while
// something is actually moving — an unsettled tween, a pursued pointer, or a
// working scan — and the loop stops entirely when the set empties.
const live = new Set<LiveMark>();
let raf = 0, last = 0;

function apply(mark: LiveMark): void {
  for (const [index, sign] of [[0, -1], [1, 1]] as const) {
    const eye = renderMarkEye(mark.cur, mark.yaw, mark.pitch, sign);
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
    const before = snapshot(mark);
    mark.cur = mixMarkParams(mark.cur, mark.tgt, kMood);
    mark.yaw += (mark.tgtYaw - mark.yaw) * kPose;
    mark.pitch += (mark.tgtPitch - mark.pitch) * kPose;
    apply(mark);
    const moving = mark.pointer !== null || mark.mood === 'working' || before !== snapshot(mark);
    if (!moving) live.delete(mark);
  }
  raf = live.size > 0 ? requestAnimationFrame(step) : 0;
  if (raf === 0) last = 0;
}

function wake(mark: LiveMark): void {
  live.add(mark);
  if (raf === 0 && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(step);
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
    };
    markRef.current = mark;
    apply(mark);
    if (mark.mood === 'working' && !reducedMotion()) wake(mark);
    return () => { live.delete(mark); markRef.current = null; };
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

  // Blinking: mostly both eyes, now and then just one, on this mark's own
  // clock — twenty faces blinking on a shared beat read as a screensaver, and
  // lockstep eyes are the tell of a machine. Closed-eye moods do not blink: a
  // sleeping face that blinks is worse than one that never does.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || reducedMotion()) return;
    const eyes = [...svg.querySelectorAll('.agent-mark-eye')];
    if (eyes.length !== 2) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
    };
    const shut = (targets: Element[], ms: number) => {
      for (const eye of targets) eye.classList.add('is-shut');
      later(() => { for (const eye of targets) eye.classList.remove('is-shut'); }, ms);
    };
    const tick = () => {
      if (AWAKE_MARK_MOODS.includes(moodRef.current)) {
        if (Math.random() < 0.16) shut([eyes[Math.random() < 0.5 ? 0 : 1]!], 180);
        else shut([...eyes], 100);
      }
      later(tick, 2600 + Math.random() * 4600);
    };
    later(tick, 600 + Math.random() * 3400);
    return () => { for (const t of timers) clearTimeout(t); };
  }, []);

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
