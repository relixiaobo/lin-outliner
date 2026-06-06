import { describe, expect, test } from 'bun:test';
import { AgentDomainEventBus } from '../../src/main/agentDomainEvents';

describe('agent domain event bus', () => {
  test('delivers events to global and lane subscribers', () => {
    const bus = new AgentDomainEventBus();
    const seen: string[] = [];
    bus.subscribe((event) => {
      seen.push(`all:${event.lane}:${event.name}`);
    });
    bus.subscribeLane('trusted-observer', (event) => {
      seen.push(`trusted:${event.name}`);
    });

    bus.publish({
      lane: 'trusted-observer',
      name: 'Notification',
      sessionId: 'session-1',
      createdAt: 1,
    });

    expect(seen).toEqual([
      'all:trusted-observer:Notification',
      'trusted:Notification',
    ]);
  });

  test('applies hook interceptors before delivery', () => {
    const bus = new AgentDomainEventBus();
    bus.useHookInterceptor((event) => ({
      ...event,
      payload: { blocked: true },
    }));

    const delivered = bus.publish({
      lane: 'hook-interceptor',
      name: 'PreToolUse',
      sessionId: 'session-1',
      payload: { blocked: false },
      createdAt: 1,
    });

    expect(delivered.payload).toEqual({ blocked: true });
  });

  test('isolates observer failures from the runtime hot path', () => {
    const bus = new AgentDomainEventBus();
    let delivered = false;
    bus.subscribe(() => {
      throw new Error('observer failed');
    });
    bus.subscribe(() => {
      delivered = true;
    });

    bus.publish({
      lane: 'trusted-observer',
      name: 'Stop',
      sessionId: 'session-1',
      createdAt: 1,
    });

    expect(delivered).toBe(true);
  });
});
