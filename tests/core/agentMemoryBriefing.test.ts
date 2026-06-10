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
  test('renders the reader pool as a second-person <self> zone and hides scaffolding', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'verify a worktree HEAD before trusting a gate run' }),
        entry({ id: 'm2', fact: 'work with lixiaobo, who wants the repo in English' }),
      ],
      { reader: READER },
    );

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('<memory>');
    // The briefing introduces itself as the working-memory slice of the semantic store
    // ([[agent-memory-foundations]] §5.3).
    expect(briefing).toContain(MEMORY_BRIEFING_INTRO);
    expect(briefing).toContain('<self>');
    expect(briefing).toContain('You verify a worktree HEAD before trusting a gate run.');
    expect(briefing).toContain('You work with lixiaobo, who wants the repo in English.');
    // Storage scaffolding never leaks into the prose.
    expect(briefing).not.toContain('m1');
    expect(briefing).not.toContain('id=');
    expect(briefing).not.toContain('status');
    expect(briefing).not.toContain('<agent-memory>');
  });

  test('renders a non-reader pool as a named third-person <principal> zone', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'p1', principal: USER, fact: 'prefers terse code reviews' })],
      { reader: READER, principalNameFor: () => 'lixiaobo' },
    );

    expect(briefing).toContain('<principal name="lixiaobo">');
    expect(briefing).toContain('lixiaobo prefers terse code reviews.');
    // The principal zone is third-person, not addressed to the reader.
    expect(briefing).not.toContain('<self>');
    expect(briefing).not.toContain('You prefers');
  });

  test('defaults a user pool name to "The user" when no resolver is given', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'p1', principal: USER, fact: 'prefers terse code reviews' })],
      { reader: READER },
    );

    expect(briefing).toContain('<principal name="The user">');
    expect(briefing).toContain('The user prefers terse code reviews.');
  });

  test('orders principal zones before self and separates the two pools', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 's1', fact: 'verify HEAD before a gate run' }),
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

  test('never deletes leading words — a noun-phrase head is not a leaked subject', () => {
    // Regression: the render must not strip "the user"/"we"/etc. from the FRONT of a fact, which
    // would change its meaning. Person assignment only prepends the subject; the subject-elided
    // contract is enforced at the Dream layer, not by mangling stored prose here.
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'the user interface uses slate focus rings' }),
        entry({ id: 'm2', fact: 'we work on the launcher this week' }),
      ],
      { reader: READER },
    );

    expect(briefing).toContain('the user interface uses slate focus rings');
    expect(briefing).not.toContain('You interface uses');
    expect(briefing).toContain('we work on the launcher this week');
    expect(briefing).not.toContain('You work on the launcher');
  });

  test('collapses internal whitespace so a fact cannot inject an extra line', () => {
    const briefing = renderAgentMemoryBriefing(
      [entry({ id: 'm1', fact: 'verify HEAD\nthen trust the gate run' })],
      { reader: READER },
    );

    expect(briefing).toContain('You verify HEAD then trust the gate run.');
    // The only newlines are the structural ones around the intro and zone, never inside a fact.
    expect(briefing).toBe(
      `<memory>\n${MEMORY_BRIEFING_INTRO}\n<self>\nYou verify HEAD then trust the gate run.\n</self>\n</memory>`,
    );
  });

  test('skips invalidated entries and dedupes by id', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'keep this active fact' }),
        entry({ id: 'm1', fact: 'duplicate id should be dropped' }),
        entry({ id: 'm2', fact: 'this one is gone', status: 'invalidated' }),
      ],
      { reader: READER },
    );

    expect(briefing).toContain('You keep this active fact.');
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
        entry({ id: 'm1', fact: 'prefer a < b style comparisons & terse output' }),
        entry({ id: 'p1', principal: { type: 'user', userId: 'x' }, fact: 'likes "quotes"' }),
      ],
      { reader: READER, principalNameFor: () => 'A & "B"' },
    );

    expect(briefing).toContain('&lt; b style comparisons &amp; terse');
    expect(briefing).toContain('name="A &amp; &quot;B&quot;"');
    expect(briefing).not.toContain('< b style');
  });
});
