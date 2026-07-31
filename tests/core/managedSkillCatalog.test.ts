import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  MANAGED_SKILL_CATALOG_PATH,
  validateManagedSkillCatalog,
} from '../../scripts/validate-managed-skill-catalog';
import { MANAGED_SKILL_LIMITS } from '../../src/main/managedSkillValidation';

const encoder = new TextEncoder();

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sample-skill',
    name: 'sample-skill',
    description: 'A syntactically valid catalog entry used as the mutation base.',
    repository: 'https://github.com/relixiaobo/linlab-skills',
    subdirectory: 'sample-skill',
    trackingRef: 'main',
    compatibilityRange: '>=0.1.0 <1.0.0',
    ...overrides,
  };
}

/** Serializes a catalog document to the bytes the validator actually sees. */
function catalogBytes(document: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(document));
}

function withEntries(...entries: unknown[]): Uint8Array {
  return catalogBytes({ schemaVersion: 1, entries });
}

describe('managed skill catalog guard', () => {
  test('accepts the checked-in catalog', () => {
    expect(validateManagedSkillCatalog(readFileSync(MANAGED_SKILL_CATALOG_PATH))).toEqual([]);
  });

  test('accepts a minimal well-formed catalog', () => {
    expect(validateManagedSkillCatalog(withEntries(validEntry()))).toEqual([]);
  });

  test('accepts an empty entry list', () => {
    expect(validateManagedSkillCatalog(withEntries())).toEqual([]);
  });

  test('rejects a catalog over the fetch byte limit', () => {
    // Padding the description is enough to cross the limit the fetch enforces.
    const oversized = withEntries(validEntry({
      description: 'x'.repeat(MANAGED_SKILL_LIMITS.catalogBytes + 1),
    }));
    expect(oversized.byteLength).toBeGreaterThan(MANAGED_SKILL_LIMITS.catalogBytes);
    expect(validateManagedSkillCatalog(oversized)[0]).toContain('over the');
  });

  test('rejects malformed JSON', () => {
    expect(validateManagedSkillCatalog(encoder.encode('{"schemaVersion":1,'))[0])
      .toContain('not valid UTF-8 JSON');
  });

  test('rejects invalid UTF-8 bytes', () => {
    expect(validateManagedSkillCatalog(new Uint8Array([0xff, 0xfe, 0x00]))[0])
      .toContain('not valid UTF-8 JSON');
  });

  test('rejects a top-level array', () => {
    expect(validateManagedSkillCatalog(catalogBytes([validEntry()]))).not.toEqual([]);
  });

  test('rejects an unsupported schemaVersion', () => {
    expect(validateManagedSkillCatalog(catalogBytes({ schemaVersion: 2, entries: [validEntry()] }))[0])
      .toContain('runtime parser');
  });

  test('rejects a missing entries array', () => {
    expect(validateManagedSkillCatalog(catalogBytes({ schemaVersion: 1 }))).not.toEqual([]);
  });

  for (const field of ['id', 'name', 'description', 'repository', 'subdirectory', 'trackingRef'] as const) {
    test(`rejects an entry missing ${field}`, () => {
      const entry = validEntry();
      delete entry[field];
      expect(validateManagedSkillCatalog(withEntries(entry))).not.toEqual([]);
    });

    test(`rejects an entry whose ${field} is blank`, () => {
      expect(validateManagedSkillCatalog(withEntries(validEntry({ [field]: '   ' })))).not.toEqual([]);
    });

    test(`rejects an entry whose ${field} is not a string`, () => {
      expect(validateManagedSkillCatalog(withEntries(validEntry({ [field]: 42 })))).not.toEqual([]);
    });
  }

  test('rejects a duplicate id', () => {
    const duplicate = withEntries(
      validEntry({ id: 'same', name: 'first' }),
      validEntry({ id: 'same', name: 'second' }),
    );
    expect(validateManagedSkillCatalog(duplicate)[0]).toContain('runtime parser');
  });

  test('rejects a duplicate name', () => {
    const duplicate = withEntries(
      validEntry({ id: 'first', name: 'same' }),
      validEntry({ id: 'second', name: 'same' }),
    );
    expect(validateManagedSkillCatalog(duplicate)[0]).toContain('runtime parser');
  });

  for (const repository of [
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/tree/main',
    'https://user:pass@github.com/owner/repo',
    'https://github.com:8443/owner/repo',
    'https://github.com/owner/repo?ref=main',
    'not-a-url',
  ]) {
    test(`rejects repository ${repository}`, () => {
      expect(validateManagedSkillCatalog(withEntries(validEntry({ repository })))).not.toEqual([]);
    });
  }

  for (const subdirectory of ['..', 'a/../b', './a', 'a\\b', '/', '']) {
    test(`rejects subdirectory ${JSON.stringify(subdirectory)}`, () => {
      expect(validateManagedSkillCatalog(withEntries(validEntry({ subdirectory })))).not.toEqual([]);
    });
  }

  // A leading dash is a legal Git ref, so it is deliberately absent here.
  for (const trackingRef of ['has space', 'refs/heads/../main', '..', '/leading-slash', 'trailing/', 'ref^', '.hidden/main', 'main.lock']) {
    test(`rejects trackingRef ${JSON.stringify(trackingRef)}`, () => {
      expect(validateManagedSkillCatalog(withEntries(validEntry({ trackingRef })))).not.toEqual([]);
    });
  }

  test('rejects an invalid SemVer compatibilityRange', () => {
    expect(validateManagedSkillCatalog(withEntries(validEntry({ compatibilityRange: 'not-a-range' })))[0])
      .toContain('runtime parser');
  });

  // The two checks below are the guard's reason to exist beyond the runtime
  // parser: both shapes parse cleanly and fail only on a user's machine.
  test('rejects an entry missing compatibilityRange, which the runtime parser allows', () => {
    const entry = validEntry();
    delete entry.compatibilityRange;
    expect(validateManagedSkillCatalog(withEntries(entry)))
      .toEqual(['Catalog entry sample-skill is missing compatibilityRange.']);
  });

  test('rejects a trailing-hyphen name, which the runtime parser allows', () => {
    expect(validateManagedSkillCatalog(withEntries(validEntry({ id: 'trailing', name: 'trailing-' }))))
      .toEqual(['Catalog entry trailing has name "trailing-", which the managed-skill install path rejects.']);
  });

  test('rejects an uppercase name', () => {
    expect(validateManagedSkillCatalog(withEntries(validEntry({ name: 'Sample' })))).not.toEqual([]);
  });

  test('reports every violating entry, not just the first', () => {
    const entry = validEntry({ id: 'second', name: 'second' });
    delete entry.compatibilityRange;
    const violations = validateManagedSkillCatalog(withEntries(
      validEntry({ id: 'first', name: 'first-' }),
      entry,
    ));
    expect(violations).toHaveLength(2);
  });
});
