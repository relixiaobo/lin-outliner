import { useEffect, useId, useRef } from 'react';

/**
 * The mark every agent wears: one soft form in the participant's identity
 * colour, with two round-capped eye strokes cut straight through to the panel.
 *
 * The eyes are HOLES in a mask, not painted pupils — they show whatever is
 * behind the mark, so a mark has exactly one colour and the eyes can never be
 * mis-paired against a theme. No ground, no crop, no frame: the form is its own
 * edge, which is what retired the tile-and-hairline treatment the portrait
 * assets needed.
 *
 * Generated, not drawn. Identity is the colour (resolved upstream, one hue per
 * Agent type); the geometry is identical for everyone. That is the deal that
 * gives a user-created Role a face the moment it is named.
 */
export function AgentMark({ tint, size }: {
  /** The `--identity-tint-<n>` index the mark is filled with. */
  readonly tint: number;
  readonly size: number;
}) {
  const maskId = useId();
  const ref = useRef<SVGSVGElement>(null);

  // Blinking: mostly both eyes, now and then just one, on this mark's own
  // clock — twenty faces blinking on a shared beat read as a screensaver, and
  // lockstep eyes are the tell of a machine. Class toggles on refs, never
  // React state: a transcript full of marks must not re-render to blink (A9).
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // Guarded, not assumed: a bare DOM (tests) has no matchMedia, and a face
    // that cannot ask about motion preferences simply keeps its eyes open.
    if (typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const eyes = svg.querySelectorAll('.agent-mark-eye');
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
      if (Math.random() < 0.16) shut([eyes[Math.random() < 0.5 ? 0 : 1]!], 180);
      else shut([...eyes], 100);
      later(tick, 2600 + Math.random() * 4600);
    };
    later(tick, 600 + Math.random() * 3400);
    return () => { for (const t of timers) clearTimeout(t); };
  }, []);

  return (
    <svg
      aria-hidden
      height={size}
      ref={ref}
      viewBox="0 0 32 32"
      width={size}
    >
      <defs>
        {/* Mask luminance, not on-screen colour: white keeps, black cuts. */}
        <mask id={maskId}>
          <rect fill="#fff" height="32" width="32" />
          {/* Luminance strokes, not on-screen colour: black cuts the hole.
              Kept as attributes so the stylesheet stays hex-free (B1 guard). */}
          <g className="agent-mark-eye" style={{ transformOrigin: '10.8px 15px' }}>
            <path d="M10.8 13.4 L10.8 16.6" fill="none" stroke="#000" strokeLinecap="round" strokeWidth="4.6" />
          </g>
          <g className="agent-mark-eye" style={{ transformOrigin: '21.2px 15px' }}>
            <path d="M21.2 13.4 L21.2 16.6" fill="none" stroke="#000" strokeLinecap="round" strokeWidth="4.6" />
          </g>
        </mask>
      </defs>
      <path
        d="M16 3.2 C23.6 3.2 28.8 8.4 28.8 16 C28.8 23.6 23.6 28.8 16 28.8 C8.4 28.8 3.2 23.6 3.2 16 C3.2 8.4 8.4 3.2 16 3.2 Z"
        fill={`var(--identity-tint-${tint})`}
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
