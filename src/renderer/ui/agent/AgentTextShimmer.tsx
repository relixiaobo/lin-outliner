import { useEffect, useState, type ReactNode } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const SHIMMER_INITIAL_DELAY_MS = 600;
const SHIMMER_SWEEP_MS = 1000;
const SHIMMER_CADENCE_MS = 4000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined'
      ? window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false
      : false
  ));

  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

export function AgentTextShimmer({ active, children }: { active: boolean; children: ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const [sweeping, setSweeping] = useState(false);

  useEffect(() => {
    if (!active || reducedMotion) {
      setSweeping(false);
      return undefined;
    }

    let sweepEndTimer: number | null = null;
    const runSweep = () => {
      setSweeping(true);
      if (sweepEndTimer !== null) window.clearTimeout(sweepEndTimer);
      sweepEndTimer = window.setTimeout(() => {
        setSweeping(false);
        sweepEndTimer = null;
      }, SHIMMER_SWEEP_MS);
    };

    const initialTimer = window.setTimeout(runSweep, SHIMMER_INITIAL_DELAY_MS);
    const cadenceTimer = window.setInterval(runSweep, SHIMMER_CADENCE_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(cadenceTimer);
      if (sweepEndTimer !== null) window.clearTimeout(sweepEndTimer);
      setSweeping(false);
    };
  }, [active, reducedMotion]);

  return (
    <span className={`agent-text-shimmer${sweeping ? ' is-active' : ''}`}>
      {children}
    </span>
  );
}
