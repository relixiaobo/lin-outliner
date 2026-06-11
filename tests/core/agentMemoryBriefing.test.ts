import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentPrincipal } from '../../src/core/agentEventLog';
import { MEMORY_BRIEFING_INTRO, renderAgentMemoryBriefing } from '../../src/main/agentMemoryBriefing';

const READER: AgentPrincipal = { type: 'agent', agentId: 'built-in:tenon:assistant' };
const USER: AgentPrincipal = { type: 'user', userId: 'lixiaobo' };

function entry(input: Partial<AgentMemoryEntry> & { id: string; fact: string }): AgentMemoryEntry {
  return {
    id: input.id,
    principal: input.principal ?? READER,
    fact: input.fact,
    originWorkspace: input.originWorkspace,
    sources: input.sources ?? [{ conversationId: 'c1' }],
    status: input.status ?? 'active',
    createdAt: input.createdAt ?? 1,
  };
}

describe('renderAgentMemoryBriefing', () => {
  test('renders the reader pool as a <self> bullet list and hides scaffolding', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'verifies a worktree HEAD before trusting a gate run' }),
        entry({ id: 'm2', fact: 'escalates directional decisions to lixiaobo before building' }),
      ],
      { reader: READER },
    );

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('<memory>');
    // The briefing introduces itself as the working-memory slice of the semantic store
    // ([[agent-memory-foundations]] §6.3).
    expect(briefing).toContain(MEMORY_BRIEFING_INTRO);
    expect(briefing).toContain('<self>');
    // Facts render verbatim as bullets — no subject prepending, no conjugation (D-2).
    expect(briefing).toContain('- verifies a worktree HEAD before trusting a gate run');
    expect(briefing).toContain('- escalates directional decisions to lixiaobo before building');
    expect(briefing).not.toContain('You verifies');
    expect(briefing).not.toContain('You verify');
    // Storage scaffolding never leaks into the briefing.
    expect(briefing).not.toContain('m1');
    expect(briefing).not.toContain('id=');
    expect(briefing).not.toContain('status');
    expect(briefing).not.toContain('<agent-memory>');
  });

  test('renders a non-reader pool as a named <principal> zone with the same bullet shape', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'p1', principal: USER, fact: 'prefers terse code reviews' })],
      { reader: READER, principalNameFor: () => 'lixiaobo' },
    );

    expect(briefing).toContain('<principal name="lixiaobo">');
    // The subject lives in the zone tag, never in the fact line.
    expect(briefing).toContain('- prefers terse code reviews');
    expect(briefing).not.toContain('lixiaobo prefers');
    expect(briefing).not.toContain('<self>');
  });

  test('defaults a user pool name to "The user" when no resolver is given', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'p1', principal: USER, fact: 'prefers terse code reviews' })],
      { reader: READER },
    );

    expect(briefing).toContain('<principal name="The user">');
    expect(briefing).toContain('- prefers terse code reviews');
  });

  test('orders principal zones before self and separates the two pools', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 's1', fact: 'verifies HEAD before a gate run' }),
        entry({ id: 'p1', principal: USER, fact: 'wants the repo in English' }),
      ],
      { reader: READER, principalNameFor: () => 'lixiaobo' },
    );

    expect(briefing).not.toBeNull();
    const principalAt = briefing!.indexOf('<principal');
    const selfAt = briefing!.indexOf('<self>');
    expect(principalAt).toBeGreaterThanOrEqual(0);
    expect(selfAt).toBeGreaterThan(principalAt);
  });

  test('renders facts verbatim — never prepends, rewrites, or deletes words', () => {
    // Regression: the render must not mutate a fact's words, which would change its meaning.
    // The phrasing contract (third-person-singular, subject-elided) is enforced at the Dream
    // layer, not by mangling stored facts here.
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'the user interface uses slate focus rings' }),
        entry({ id: 'm2', fact: 'we work on the launcher this week' }),
      ],
      { reader: READER },
    );

    expect(briefing).toContain('- the user interface uses slate focus rings');
    expect(briefing).toContain('- we work on the launcher this week');
    expect(briefing).not.toContain('You ');
  });

  test('collapses internal whitespace so a fact cannot inject an extra line or fake bullet', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'm1', fact: 'verifies HEAD\nthen trusts the gate run' })],
      { reader: READER },
    );

    expect(briefing).toContain('- verifies HEAD then trusts the gate run');
    // The only newlines are the structural ones around the intro, zone, and bullets —
    // never inside a fact.
    expect(briefing).toBe(
      `<memory>\n${MEMORY_BRIEFING_INTRO}\n<self>\n- verifies HEAD then trusts the gate run\n</self>\n</memory>`,
    );
  });

  test('one fact per bullet line', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'verifies HEAD before a gate run' }),
        entry({ id: 'm2', fact: 'keeps PRs single-purpose' }),
      ],
      { reader: READER },
    );

    const selfZone = briefing!.split('<self>\n')[1]!.split('\n</self>')[0]!;
    expect(selfZone.split('\n')).toEqual([
      '- verifies HEAD before a gate run',
      '- keeps PRs single-purpose',
    ]);
  });

  test('skips invalidated entries and dedupes by id', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'keeps this active fact' }),
        entry({ id: 'm1', fact: 'duplicate id should be dropped' }),
        entry({ id: 'm2', fact: 'this one is gone', status: 'invalidated' }),
      ],
      { reader: READER },
    );

    expect(briefing).toContain('- keeps this active fact');
    expect(briefing).not.toContain('duplicate id should be dropped');
    expect(briefing).not.toContain('this one is gone');
  });

  test('returns null when there is no active memory', () => {
    expect(renderAgentMemoryBriefing([], { reader: READER })).toBeNull();
    expect(
      renderAgentMemoryBriefing(
        [entry({ id: 'm1', fact: 'gone', status: 'invalidated' })],
        { reader: READER },
      ),
    ).toBeNull();
  });

  test('XML-escapes fact bodies and principal names', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'prefers a < b style comparisons & terse output' }),
        entry({ id: 'p1', principal: { type: 'user', userId: 'x' }, fact: 'likes "quotes"' }),
      ],
      { reader: READER, principalNameFor: () => 'A & "B"' },
    );

    expect(briefing).toContain('&lt; b style comparisons &amp; terse');
    expect(briefing).toContain('name="A &amp; &quot;B&quot;"');
    expect(briefing).not.toContain('< b style');
  });
});
