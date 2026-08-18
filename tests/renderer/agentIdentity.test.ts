import { describe, expect, test } from 'bun:test';
import type { AgentIdentityEntry } from '../../src/core/agent/protocol';
import { deriveIdentityColor } from '../../src/core/agent/configuration';
import {
  EMPTY_IDENTITY_CATALOG,
  identityCatalogFrom,
  resolveAgentIdentity,
} from '../../src/renderer/agent/agentIdentity';

const CATALOG = identityCatalogFrom([
  { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
  { agentType: 'explore', persona: 'Rena', color: 'orange', source: 'built-in' },
  { agentType: 'auditor', persona: 'auditor', color: 'violet', source: 'user' },
] satisfies AgentIdentityEntry[]);

describe('agent identity resolution', () => {
  test('names a configured type by its persona and wears its catalog colour', () => {
    expect(resolveAgentIdentity(CATALOG, 'explore')).toEqual({
      name: 'Rena', color: 'orange', tint: 1,
    });
    expect(resolveAgentIdentity(CATALOG, 'main')).toEqual({
      name: 'Aspen', color: 'teal', tint: 4,
    });
  });

  test('falls back to the type name and a derived colour, and never throws', () => {
    // A type the catalog does not know — a Role deleted after its run.
    expect(resolveAgentIdentity(CATALOG, 'retired-role')).toEqual({
      name: 'retired-role',
      color: deriveIdentityColor('retired-role'),
      tint: expect.any(Number),
    });
    // Not a type at all: an isolated Skill carries its own name.
    expect(resolveAgentIdentity(CATALOG, null, 'code-review').name).toBe('code-review');
    // Nothing to go on at all still resolves to something drawable.
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, null).name).toBe('?');
  });

  test('degrades a stale catalog colour to derivation instead of drawing nothing', () => {
    const stale = identityCatalogFrom([
      { agentType: 'explore', persona: 'Rena', color: 'chartreuse', source: 'user' },
    ]);
    expect(resolveAgentIdentity(stale, 'explore').color).toBe(deriveIdentityColor('explore'));
  });

  test('keys the derived colour off the type, so renaming a persona cannot repaint it', () => {
    const before = resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'reviewer');
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'reviewer')).toEqual(before);
  });
});
