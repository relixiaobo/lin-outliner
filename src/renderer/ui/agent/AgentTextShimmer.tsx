import { useEffect, useState, type ReactNode } from 'react';
import { REDUCED_MOTION_QUERY, prefersReducedMotion } from '../prefersReducedMotion';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

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

  return (
    <span className={`agent-text-shimmer${active && !reducedMotion ? ' is-active' : ''}`}>
      {children}
    </span>
  );
}
