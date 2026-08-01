import { describe, expect, test } from 'bun:test';
import { isSkillEnabled } from '../../src/main/agent/capabilities/agentSkills';
import type { SkillSourceKind } from '../../src/core/types';

/**
 * One meaning of "on" — available to the model right now:
 *
 *     enabled(skill) = activation(skill) && !disabledSkills.includes(name)
 *
 * `activation` is the managed index's per-record flag for `managed` and
 * constant-true for every other source. Getting this wrong makes skills
 * silently vanish from, or appear in, the catalog the model sees, so every
 * source is covered here — including the cross case where both terms apply.
 */

// A local directory contributes skills under the `user` / `project` sources, so
// the five sources a user can see collapse to these four kinds plus activation.
const UNMANAGED_SOURCES: SkillSourceKind[] = ['built-in', 'user', 'project'];

function enabled(
  name: string,
  source: SkillSourceKind,
  disabledSkills: readonly string[],
  activeManagedSkillNames: readonly string[],
): boolean {
  return isSkillEnabled(
    { name, source },
    { disabledSkills, activeManagedSkillNames: new Set(activeManagedSkillNames) },
  );
}

describe('skill enable predicate', () => {
  for (const source of UNMANAGED_SOURCES) {
    test(`${source} is enabled by default`, () => {
      expect(enabled('demo', source, [], [])).toBe(true);
    });

    test(`${source} is disabled by disabledSkills`, () => {
      expect(enabled('demo', source, ['demo'], [])).toBe(false);
    });

    test(`${source} ignores managed activation entirely`, () => {
      // Not being in the activated-managed set must not disable a non-managed
      // skill; only `managed` consults that set.
      expect(enabled('demo', source, [], ['something-else'])).toBe(true);
    });
  }

  test('an activated managed skill is enabled', () => {
    expect(enabled('pdf', 'managed', [], ['pdf'])).toBe(true);
  });

  test('an installed-but-not-activated managed skill is disabled', () => {
    expect(enabled('pdf', 'managed', [], [])).toBe(false);
  });

  test('an activated managed skill named in disabledSkills is disabled', () => {
    // The behaviour this predicate exists to fix: disabledSkills used to skip
    // managed skills entirely, so this case silently stayed enabled.
    expect(enabled('pdf', 'managed', ['pdf'], ['pdf'])).toBe(false);
  });

  test('a managed skill that is neither activated nor allowed is disabled', () => {
    // The cross case: both terms are false. It must not resolve to enabled
    // through either path.
    expect(enabled('pdf', 'managed', ['pdf'], [])).toBe(false);
  });

  test('managed activation is matched on the normalized skill name', () => {
    // normalizeSkillName strips a leading slash; it does not fold case, since
    // skill names are already validated lowercase.
    expect(enabled('/pdf', 'managed', [], ['pdf'])).toBe(true);
    expect(enabled('PDF', 'managed', [], ['pdf'])).toBe(false);
  });

  test('disabledSkills only disables the named skill', () => {
    expect(enabled('other', 'managed', ['pdf'], ['other', 'pdf'])).toBe(true);
    expect(enabled('other', 'user', ['pdf'], [])).toBe(true);
  });
});
