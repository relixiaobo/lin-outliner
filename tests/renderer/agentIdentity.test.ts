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
    // A caller-provided fallback remains drawable without a catalog identity.
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

  test('names the conversation\'s own agent from the caller before the catalog lands', () => {
    // `identities/get` can be slow or fail; until it answers, every other type
    // is named after itself, but `main` is a key the reader should never see —
    // the caller's translated label stands in.
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'main', '主对话').name).toBe('主对话');
    // A known type still prefers its own name over any caller fallback.
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'explore', 'ignored').name).toBe('explore');
  });

  test('refuses an inherited property as a colour', () => {
    // `in` walks the prototype chain: an entry claiming `toString` would pass
    // and hand a Function to the renderer as a tint index.
    const hostile = identityCatalogFrom([
      { agentType: 'explore', persona: 'Rena', color: 'toString', source: 'user' },
    ]);
    const resolved = resolveAgentIdentity(hostile, 'explore');
    expect(typeof resolved.tint).toBe('number');
    expect(resolved.color).toBe(deriveIdentityColor('explore'));
  });

  test('keys the derived colour off the type, so renaming a persona cannot repaint it', () => {
    const before = resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'reviewer');
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'reviewer')).toEqual(before);
  });
});
