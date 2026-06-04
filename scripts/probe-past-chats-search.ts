import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../src/core/agentEventLog';
import { AgentEventStore } from '../src/main/agentEventStore';
import { AgentPastChatsService } from '../src/main/agentPastChats';

const sessionCount = Number(process.argv[2] ?? 200);
const messagesPerSession = Number(process.argv[3] ?? 20);
const root = await mkdtemp(path.join(tmpdir(), 'lin-past-chats-probe-'));
const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'probe-user' };

try {
  const store = new AgentEventStore(root);
  const build = await timeAsync(() => seedStore(store, sessionCount, messagesPerSession));
  const service = new AgentPastChatsService(store);
  const middleSession = `session-${Math.floor(sessionCount / 2)}`;
  const after = new Date(createdAtFor(50, 1)).toISOString();
  const before = new Date(createdAtFor(Math.min(sessionCount - 1, 120), messagesPerSession)).toISOString();
  const searches = [
    ['phrase', () => service.search({ query: 'sqlite checkpoint', includeCurrentSession: true, limit: 20 })],
    ['cjk', () => service.search({ query: '成都天气', includeCurrentSession: true, limit: 20 })],
    ['session_filter', () => service.search({
      query: 'sqlite checkpoint',
      sessionIds: [middleSession],
      includeCurrentSession: true,
      limit: 20,
    })],
    ['date_filter', () => service.search({
      query: 'checkpoint',
      after,
      before,
      includeCurrentSession: true,
      limit: 20,
    })],
    ['current_session_excluded', () => service.search(
      { query: 'graphite palette', limit: 20 },
      { currentSessionId: 'session-0' },
    )],
  ] as const;

  const results = [];
  for (const [name, run] of searches) {
    const measured = await timeAsync(run);
    results.push({
      name,
      durationMs: measured.durationMs,
      hits: measured.value.mode === 'search' ? measured.value.hits.length : 0,
      totalHits: measured.value.mode === 'search' ? measured.value.totalHits : 0,
      firstMessageId: measured.value.mode === 'search' ? measured.value.hits[0]?.messageId ?? null : null,
    });
  }

  const recent = await timeAsync(() => service.recent({ includeCurrentSession: true, limit: 50 }));
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    sessions: sessionCount,
    messagesPerSession,
    totalMessages: sessionCount * messagesPerSession,
    seedMs: build.durationMs,
    searches: results,
    recent: {
      durationMs: recent.durationMs,
      items: recent.value.mode === 'recent' ? recent.value.items.length : 0,
    },
    memoryMB: {
      rss: bytesToMb(memory.rss),
      heapUsed: bytesToMb(memory.heapUsed),
    },
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function seedStore(store: AgentEventStore, sessions: number, messagesPerSession: number) {
  for (let sessionIndex = 0; sessionIndex < sessions; sessionIndex += 1) {
    const sessionId = `session-${sessionIndex}`;
    const events: AgentEvent[] = [
      {
        ...base(sessionId, sessionIndex, 1, 'session.created'),
        title: `Probe Session ${sessionIndex}`,
      },
    ];
    for (let messageIndex = 0; messageIndex < messagesPerSession; messageIndex += 1) {
      events.push({
        ...base(sessionId, sessionIndex, messageIndex + 2, 'user_message.created', userActor),
        messageId: `${sessionId}-message-${messageIndex}`,
        parentMessageId: messageIndex === 0 ? null : `${sessionId}-message-${messageIndex - 1}`,
        content: [{ type: 'text', text: messageText(sessionIndex, messageIndex) }],
      });
    }
    await store.appendEvents(sessionId, events);
  }
}

function base(
  sessionId: string,
  sessionIndex: number,
  seq: number,
  type: AgentEvent['type'],
  actor: AgentActor = systemActor,
) {
  return {
    v: 1 as const,
    eventId: `${sessionId}-event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: createdAtFor(sessionIndex, seq),
    actor,
  };
}

function createdAtFor(sessionIndex: number, seq: number): number {
  return 1_800_000_000_000 + sessionIndex * 100_000 + seq * 100;
}

function messageText(sessionIndex: number, messageIndex: number): string {
  if (sessionIndex === 0 && messageIndex === 0) return 'Remember the graphite palette';
  if ((sessionIndex + messageIndex) % 37 === 0) return `sqlite checkpoint strategy exact ${sessionIndex}-${messageIndex}`;
  if ((sessionIndex + messageIndex) % 23 === 0) return `checkpoint details for sqlite migration ${sessionIndex}-${messageIndex}`;
  if ((sessionIndex + messageIndex) % 41 === 0) return `成都天气 retrieval note ${sessionIndex}-${messageIndex}`;
  return `routine planning note ${sessionIndex}-${messageIndex}`;
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, durationMs: roundMs(performance.now() - started) };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function bytesToMb(value: number): number {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}
