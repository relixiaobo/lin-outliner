import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentPrincipal } from '../../src/core/agentEventLog';
import type { AgentMemoryOverview } from '../../src/core/agentMemoryActivation';
import { MEMORY_BRIEFING_INTRO, renderAgentMemoryBriefing } from '../../src/main/agentMemoryBriefing';

const BELIEVER: AgentPrincipal = { type: 'agent', agentId: 'built-in:tenon:assistant' };

function entry(input: Partial<AgentMemoryEntry> & { id: string; fact: string }): AgentMemoryEntry {
  return {
    id: input.id,
    principal: input.principal ?? BELIEVER,
    fact: input.fact,
    originWorkspace: input.originWorkspace,
    sources: input.sources ?? [{
      stream: 'conversation',
      streamId: 'c1',
      range: { fromSeqExclusive: 0, throughSeq: 1, throughEventId: 'c1-event-1' },
    }],
    status: input.status ?? 'active',
    createdAt: input.createdAt ?? 1,
  };
}

function overview(): AgentMemoryOverview {
  return {
    generatedAt: 100,
    totalEntries: 2,
    schema: [
      {
        id: 'memory-schema:reviews',
        label: 'reviews',
        memoryIds: ['m1', 'm2'],
        entryCount: 2,
        storageStrength: 2,
        retrievalStrength: 1.5,
      },
    ],
  };
}

describe('renderAgentMemoryBriefing', () => {
  test('renders the believer pool as a flat <memory> bullet list and hides scaffolding', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'the user prefers terse code reviews' }),
      entry({ id: 'm2', fact: 'the auth module verifies JWTs before authorizing' }),
    ]);

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('<memory>');
    // The briefing introduces itself as the working-memory slice of the semantic store
    // ([[agent-memory-foundations]] §6.3).
    expect(briefing).toContain(MEMORY_BRIEFING_INTRO);
    // One pool, one flat list — no zone tags.
    expect(briefing).not.toContain('<self>');
    expect(briefing).not.toContain('<principal');
    // Facts render verbatim as bullets; the subject is named inside the fact text.
    expect(briefing).toContain('- the user prefers terse code reviews');
    expect(briefing).toContain('- the auth module verifies JWTs before authorizing');
    // Storage scaffolding never leaks into the briefing.
    expect(briefing).not.toContain('m1');
    expect(briefing).not.toContain('id=');
    expect(briefing).not.toContain('status');
    expect(briefing).not.toContain('<agent-memory>');
  });

  test('renders facts verbatim — never prepends, rewrites, or deletes words', () => {
    // Regression: the render must not mutate a fact's words, which would change its meaning.
    // The phrasing contract (subject-named third person) is enforced at the Dream layer, not
    // by mangling stored facts here.
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'the user interface uses slate focus rings' }),
      entry({ id: 'm2', fact: 'the team works on the launcher this week' }),
    ]);

    expect(briefing).toContain('- the user interface uses slate focus rings');
    expect(briefing).toContain('- the team works on the launcher this week');
    expect(briefing).not.toContain('You ');
  });

  test('collapses internal whitespace so a fact cannot inject an extra line or fake bullet', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'the gate run is trusted\nonly after HEAD verification' }),
    ]);

    expect(briefing).toContain('- the gate run is trusted only after HEAD verification');
    // The only newlines are the structural ones around the intro and bullets —
    // never inside a fact.
    expect(briefing).toBe(
      `<memory>\n${MEMORY_BRIEFING_INTRO}\n- the gate run is trusted only after HEAD verification\n</memory>`,
    );
  });

  test('one fact per bullet line', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'the gate run requires a verified HEAD' }),
      entry({ id: 'm2', fact: 'the project keeps PRs single-purpose' }),
    ]);

    const body = briefing!.split(`${MEMORY_BRIEFING_INTRO}\n`)[1]!.split('\n</memory>')[0]!;
    expect(body.split('\n')).toEqual([
      '- the gate run requires a verified HEAD',
      '- the project keeps PRs single-purpose',
    ]);
  });

  test('renders a schema overview without exposing memory ids', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'm1', fact: 'the user prefers terse code reviews' })],
      { overview: overview() },
    );

    expect(briefing).toContain('<overview>');
    expect(briefing).toContain('- reviews: 2 facts');
    expect(briefing).not.toContain('memory-schema:reviews');
    expect(briefing).not.toContain('m2');
  });

  test('skips invalidated entries and dedupes by id', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'keeps this active fact' }),
      entry({ id: 'm1', fact: 'duplicate id should be dropped' }),
      entry({ id: 'm2', fact: 'this one is gone', status: 'invalidated' }),
    ]);

    expect(briefing).toContain('- keeps this active fact');
    expect(briefing).not.toContain('duplicate id should be dropped');
    expect(briefing).not.toContain('this one is gone');
  });

  test('returns null when there is no active memory', () => {
    expect(renderAgentMemoryBriefing([])).toBeNull();
    expect(
      renderAgentMemoryBriefing([entry({ id: 'm1', fact: 'gone', status: 'invalidated' })]),
    ).toBeNull();
  });

  test('XML-escapes fact bodies', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({ id: 'm1', fact: 'the comparator prefers a < b style comparisons & terse output' }),
      entry({ id: 'p1', fact: 'the formatter likes "quotes"' }),
    ]);

    expect(briefing).toContain('&lt; b style comparisons &amp; terse');
    expect(briefing).toContain('the formatter likes &quot;quotes&quot;');
    expect(briefing).not.toContain('< b style');
  });

  test('redacts secret-like facts before injection', () => {
    const briefing = renderAgentMemoryBriefing([
      entry({
        id: 'p1',
        fact: 'the test harness keeps api_key=abcdefghijklmnopqrstuvwxyz123456 for tests',
      }),
    ]);

    expect(briefing).toContain('[redacted secret-like content]');
    expect(briefing).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});
