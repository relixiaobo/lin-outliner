import { describe, expect, test } from 'bun:test';
import type { AgentIdentityEntry } from '../../src/core/agent/protocol';
import {
  EMPTY_IDENTITY_CATALOG,
  identityCatalogFrom,
  resolveAgentIdentity,
} from '../../src/renderer/agent/agentIdentity';

const CATALOG = identityCatalogFrom([
  { agentType: 'main', persona: 'Tenon', avatar: 'beaver', source: 'built-in' },
  { agentType: 'explore', persona: 'Rena', avatar: 'fox', source: 'built-in' },
  { agentType: 'auditor', persona: 'auditor', avatar: null, source: 'user' },
] satisfies AgentIdentityEntry[]);

describe('agent identity resolution', () => {
  test('names a configured type by its persona and dresses it in its portrait', () => {
    expect(resolveAgentIdentity(CATALOG, 'explore')).toMatchObject({
      name: 'Rena',
      avatarKey: 'fox',
      initial: 'R',
    });
  });

  test('falls back to the type name, then the caller name, and never throws', () => {
    // A type the catalog does not know — a Role deleted after its run.
    expect(resolveAgentIdentity(CATALOG, 'retired-role')).toMatchObject({
      name: 'retired-role',
      avatarKey: null,
    });
    // Not a type at all: an isolated Skill carries its own name.
    expect(resolveAgentIdentity(CATALOG, null, 'code-review')).toMatchObject({
      name: 'code-review',
      avatarKey: null,
    });
    // Nothing to go on at all still resolves to something drawable.
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, null)).toMatchObject({
      name: '?',
      avatarKey: null,
    });
  });

  test('keeps a configured Role without a portrait on the initial disc', () => {
    expect(resolveAgentIdentity(CATALOG, 'auditor')).toMatchObject({
      name: 'auditor',
      avatarKey: null,
      initial: 'A',
    });
  });

  test('colours by type, so renaming a persona does not repaint its disc', () => {
    const before = resolveAgentIdentity(CATALOG, 'explore').color;
    const renamed = identityCatalogFrom([
      { agentType: 'explore', persona: 'Scout', avatar: 'fox', source: 'user' },
    ]);

    expect(resolveAgentIdentity(renamed, 'explore').color).toEqual(before);
  });

  test('an empty catalog still names every type, so a slow load is not a blank deck', () => {
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'explore').name).toBe('explore');
    expect(resolveAgentIdentity(EMPTY_IDENTITY_CATALOG, 'main').name).toBe('main');
  });
});
