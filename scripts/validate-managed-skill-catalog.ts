#!/usr/bin/env bun
/**
 * Guards `catalog/managed-skills-v1.json` — the only file in this repository
 * whose contents reach users without a release. `managedSkillService.ts` fetches
 * it from `main` over raw.githubusercontent.com on every `loadCatalog()`, so a
 * malformed push degrades every existing install to its local cache and gives a
 * new install nothing at all.
 *
 * The guard runs the *runtime* parser (`parseCatalogDocument`) rather than a
 * second implementation: two parsers would drift, and the day they drifted the
 * guard would report green while users saw an empty catalog.
 *
 * On top of the runtime parse it enforces what the runtime deliberately does not.
 * The loader has to stay permissive — it parses bytes it did not author and must
 * degrade rather than throw the catalog away — but a file *we* check in has no
 * such excuse, and each of these gaps would otherwise surface only on a user's
 * machine:
 *
 *   - `compatibilityRange` is optional to the parser. An entry missing it
 *     advertises a skill with no declared compatibility bound.
 *   - The parser's name pattern (`^[a-z0-9][a-z0-9-]{0,63}$`) admits a trailing
 *     hyphen; the install path's `SKILL_NAME_PATTERN` does not. Such an entry
 *     lists fine and disagrees with the skill it installs.
 *   - Total size is capped at the *fetch*, not in the parse, so an oversized
 *     catalog is rejected on every user's machine and nowhere else.
 *
 * Offline and deterministic. Exits 1 on any violation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCatalogDocument } from '../src/main/managedSkillService';
import { MANAGED_SKILL_LIMITS, SKILL_NAME_PATTERN } from '../src/main/managedSkillValidation';

export const MANAGED_SKILL_CATALOG_PATH = join(import.meta.dir, '..', 'catalog', 'managed-skills-v1.json');

/**
 * Validates the catalog's raw bytes. Returns the violations it found; an empty
 * array means the file is publishable.
 */
export function validateManagedSkillCatalog(bytes: Uint8Array): string[] {
  const errors: string[] = [];

  if (bytes.byteLength > MANAGED_SKILL_LIMITS.catalogBytes) {
    errors.push(
      `Catalog is ${bytes.byteLength} bytes, over the ${MANAGED_SKILL_LIMITS.catalogBytes}-byte fetch limit; `
      + 'every client would reject it.',
    );
    return errors;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    errors.push(`Catalog is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }

  // The runtime parser owns schemaVersion, the required string fields, id/name
  // uniqueness, the github.com repository URL, the subdirectory shape, the
  // tracking ref, and SemVer validity of any range that is present.
  let document;
  try {
    document = parseCatalogDocument(raw);
  } catch (error) {
    errors.push(`Catalog fails the runtime parser: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }

  for (const entry of document.entries) {
    if (entry.compatibilityRange === undefined) {
      errors.push(`Catalog entry ${entry.id} is missing compatibilityRange.`);
    }
    if (!SKILL_NAME_PATTERN.test(entry.name)) {
      errors.push(
        `Catalog entry ${entry.id} has name "${entry.name}", which the managed-skill install path rejects.`,
      );
    }
  }

  return errors;
}

if (import.meta.main) {
  const violations = validateManagedSkillCatalog(readFileSync(MANAGED_SKILL_CATALOG_PATH));
  if (violations.length > 0) {
    console.error('catalog/managed-skills-v1.json is not publishable:');
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log('catalog/managed-skills-v1.json is publishable.');
}
