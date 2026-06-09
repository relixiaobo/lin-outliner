import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry } from '../../src/core/agentEventLog';
import { renderAgentMemoryBriefing } from '../../src/main/agentMemoryBriefing';

const READER = 'built-in:tenon:assistant';

function entry(input: Partial<AgentMemoryEntry> & { id: string; fact: string }): AgentMemoryEntry {
  return {
    id: input.id,
    agentId: input.agentId ?? READER,
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
      { readerAgentId: READER },
    );

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('<memory>');
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
      [entry({ id: 'p1', agentId: 'user:person:lixiaobo', fact: 'prefers terse code reviews' })],
      { readerAgentId: READER, principalNameFor: () => 'lixiaobo' },
    );

    expect(briefing).toContain('<principal name="lixiaobo">');
    expect(briefing).toContain('lixiaobo prefers terse code reviews.');
    // The principal zone is third-person, not addressed to the reader.
    expect(briefing).not.toContain('<self>');
    expect(briefing).not.toContain('You prefers');
  });

  test('orders principal zones before self and separates the two pools', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 's1', fact: 'verify HEAD before a gate run' }),
        entry({ id: 'p1', agentId: 'user:person:lixiaobo', fact: 'wants the repo in English' }),
      ],
      { readerAgentId: READER, principalNameFor: () => 'lixiaobo' },
    );

    expect(briefing).not.toBeNull();
    const principalAt = briefing!.indexOf('<principal');
    const selfAt = briefing!.indexOf('<self>');
    expect(principalAt).toBeGreaterThanOrEqual(0);
    expect(selfAt).toBeGreaterThan(principalAt);
  });

  test('does not double the subject when a fact leaks a leading pronoun', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'You verify HEAD before a gate run' }),
        entry({ id: 'm2', fact: "The user prefers terse reviews" }),
      ],
      { readerAgentId: READER },
    );

    expect(briefing).toContain('You verify HEAD before a gate run.');
    expect(briefing).not.toContain('You You verify');
    expect(briefing).toContain('You prefers terse reviews.');
    expect(briefing).not.toContain('You The user prefers');
  });

  test('skips invalidated entries and dedupes by id', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'keep this active fact' }),
        entry({ id: 'm1', fact: 'duplicate id should be dropped' }),
        entry({ id: 'm2', fact: 'this one is gone', status: 'invalidated' }),
      ],
      { readerAgentId: READER },
    );

    expect(briefing).toContain('You keep this active fact.');
    expect(briefing).not.toContain('duplicate id should be dropped');
    expect(briefing).not.toContain('this one is gone');
  });

  test('returns null when there is no active memory', () => {
    expect(renderAgentMemoryBriefing([], { readerAgentId: READER })).toBeNull();
    expect(
      renderAgentMemoryBriefing(
        [entry({ id: 'm1', fact: 'gone', status: 'invalidated' })],
        { readerAgentId: READER },
      ),
    ).toBeNull();
  });

  test('XML-escapes fact bodies and principal names', () => {
    const briefing = renderAgentMemoryBriefing(
      [
        entry({ id: 'm1', fact: 'prefer a < b style comparisons & terse output' }),
        entry({ id: 'p1', agentId: 'user:person:x', fact: 'likes "quotes"' }),
      ],
      { readerAgentId: READER, principalNameFor: () => 'A & "B"' },
    );

    expect(briefing).toContain('&lt; b style comparisons &amp; terse');
    expect(briefing).toContain('name="A &amp; &quot;B&quot;"');
    expect(briefing).not.toContain('< b style');
  });
});
