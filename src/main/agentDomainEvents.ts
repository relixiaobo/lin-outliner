import type { AgentRenderProjection, AgentRenderProjectionPatch } from '../core/agentRenderProjection';
import type { AgentEvent } from '../core/agentEventLog';

export type AgentDomainEventLane =
  | 'persisted-log'
  | 'renderer-projection'
  | 'trusted-observer'
  | 'hook-interceptor';

export type AgentLifecycleDomainEventName =
  | 'ConversationStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreCompact'
  | 'PostCompact'
  | 'Stop';

export type AgentDomainEvent =
  | {
      lane: 'persisted-log';
      name: 'PersistedLogEvent';
      conversationId: string;
      runId?: string;
      event: AgentEvent;
      createdAt: number;
    }
  | {
      lane: 'renderer-projection';
      name: 'RendererProjectionUpdated';
      conversationId: string;
      lastEventType: string | null;
      revision: number;
      projection: AgentRenderProjection;
      projectionPatch?: never;
      createdAt: number;
    }
  | {
      lane: 'renderer-projection';
      name: 'RendererProjectionUpdated';
      conversationId: string;
      lastEventType: string | null;
      revision: number;
      projection?: never;
      projectionPatch: AgentRenderProjectionPatch;
      createdAt: number;
    }
  | {
      lane: 'trusted-observer';
      name: AgentLifecycleDomainEventName | 'Notification';
      conversationId: string;
      runId?: string;
      payload?: unknown;
      createdAt: number;
    }
  | {
      lane: 'hook-interceptor';
      name: AgentLifecycleDomainEventName;
      conversationId: string;
      runId?: string;
      payload?: unknown;
      createdAt: number;
    };

type AgentDomainEventListener<TEvent extends AgentDomainEvent = AgentDomainEvent> = (
  event: TEvent,
) => void | Promise<void>;

type AgentHookInterceptor = (
  event: Extract<AgentDomainEvent, { lane: 'hook-interceptor' }>,
) => Extract<AgentDomainEvent, { lane: 'hook-interceptor' }> | void;

export class AgentDomainEventBus {
  private readonly listeners = new Set<AgentDomainEventListener>();
  private readonly laneListeners = new Map<AgentDomainEventLane, Set<AgentDomainEventListener>>();
  private readonly hookInterceptors = new Set<AgentHookInterceptor>();

  subscribe(listener: AgentDomainEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeLane<TLane extends AgentDomainEventLane>(
    lane: TLane,
    listener: AgentDomainEventListener<Extract<AgentDomainEvent, { lane: TLane }>>,
  ): () => void {
    const listeners = this.laneListeners.get(lane) ?? new Set<AgentDomainEventListener>();
    listeners.add(listener as AgentDomainEventListener);
    this.laneListeners.set(lane, listeners);
    return () => {
      listeners.delete(listener as AgentDomainEventListener);
      if (listeners.size === 0) this.laneListeners.delete(lane);
    };
  }

  useHookInterceptor(interceptor: AgentHookInterceptor): () => void {
    this.hookInterceptors.add(interceptor);
    return () => {
      this.hookInterceptors.delete(interceptor);
    };
  }

  publish(event: AgentDomainEvent): AgentDomainEvent {
    const delivered = event.lane === 'hook-interceptor' ? this.applyHookInterceptors(event) : event;
    const laneListeners = this.laneListeners.get(delivered.lane) ?? [];
    for (const listener of [...this.listeners, ...laneListeners]) {
      try {
        const result = listener(delivered);
        if (result) void result.catch(() => undefined);
      } catch {
        // Domain observers must not break the agent runtime hot path.
      }
    }
    return delivered;
  }

  private applyHookInterceptors(
    event: Extract<AgentDomainEvent, { lane: 'hook-interceptor' }>,
  ): Extract<AgentDomainEvent, { lane: 'hook-interceptor' }> {
    let current = event;
    for (const interceptor of this.hookInterceptors) {
      current = interceptor(current) ?? current;
    }
    return current;
  }
}
