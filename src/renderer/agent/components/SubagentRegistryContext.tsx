import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { ThreadId } from '../../../core/agent/protocol';
import type { SubagentRegistryEntry } from '../subagentPresentation';

/** Opening an Agent's detail view, and stopping one, from anywhere it appears. */
export interface SubagentActions {
  readonly openAgent: (agentId: ThreadId) => void;
  readonly stopAgent: ((agentId: ThreadId) => Promise<void>) | null;
}

interface SubagentRegistryValue {
  readonly byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>;
  readonly actions: SubagentActions;
}

const EMPTY_REGISTRY: SubagentRegistryValue = {
  byAgentId: new Map(),
  actions: { openAgent: () => undefined, stopAgent: null },
};

/**
 * The conversation's Agents, read where they are rendered.
 *
 * A chip is a leaf that names one Agent, and the anchors around it never change
 * when that Agent's status does. Passing the registry down as a prop would make
 * every Turn re-render whenever any Agent advanced; reading it here keeps the
 * update at the one row whose subject moved.
 */
const SubagentRegistryContext = createContext<SubagentRegistryValue>(EMPTY_REGISTRY);

/**
 * Which Agents are working right now, and nothing else about them.
 *
 * A Turn asks only one question of the registry — does a chip inside me own the
 * live cue? — and it must not re-render every second because an unrelated
 * Agent's elapsed time advanced. This narrower value changes only when an Agent
 * starts or stops working, which is exactly when the answer can change.
 */
const SubagentLivenessContext = createContext<ReadonlySet<ThreadId>>(new Set<ThreadId>());

export function SubagentRegistryProvider({
  actions,
  byAgentId,
  children,
}: {
  readonly actions: SubagentActions;
  readonly byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ actions, byAgentId }), [actions, byAgentId]);
  const workingAgentIds = useStableWorkingAgentIds(byAgentId);
  return (
    <SubagentRegistryContext.Provider value={value}>
      <SubagentLivenessContext.Provider value={workingAgentIds}>
        {children}
      </SubagentLivenessContext.Provider>
    </SubagentRegistryContext.Provider>
  );
}

function useStableWorkingAgentIds(
  byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>,
): ReadonlySet<ThreadId> {
  const previous = useRef<ReadonlySet<ThreadId>>(new Set<ThreadId>());
  return useMemo(() => {
    const working = new Set<ThreadId>();
    for (const entry of byAgentId.values()) {
      if (entry.status === 'running' || entry.status === 'pendingInit') working.add(entry.agentId);
    }
    const unchanged = working.size === previous.current.size
      && [...working].every((agentId) => previous.current.has(agentId));
    if (!unchanged) previous.current = working;
    return previous.current;
  }, [byAgentId]);
}

export function useWorkingAgentIds(): ReadonlySet<ThreadId> {
  return useContext(SubagentLivenessContext);
}

export function useSubagentEntry(agentId: ThreadId | null): SubagentRegistryEntry | null {
  const registry = useContext(SubagentRegistryContext);
  return agentId === null ? null : registry.byAgentId.get(agentId) ?? null;
}

export function useSubagentActions(): SubagentActions {
  return useContext(SubagentRegistryContext).actions;
}
