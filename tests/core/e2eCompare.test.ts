import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The branch↔baseline subtraction. Its whole value is attribution, so the cases
 * that matter are the ones where it could blame the wrong party: a missing
 * baseline must not read as "all yours", and a failure that also fails on `main`
 * must not be listed as introduced.
 */
const COMPARE = join(import.meta.dir, '../../scripts/e2e-compare.ts');

interface Summary {
  total: number;
  tests: { id: string; title: string; count: number }[];
}

function run(branch: Summary, baseline?: Summary): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-compare-'));
  const branchPath = join(dir, 'branch.json');
  writeFileSync(branchPath, JSON.stringify(branch));
  const args = [COMPARE, branchPath];
  if (baseline) {
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    args.push(baselinePath);
  }
  const result = Bun.spawnSync(['bun', ...args]);
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

const MINE = { id: 'new.spec.ts:1', title: 'broken by this branch', count: 5 };
const THEIRS = { id: 'old.spec.ts:2', title: 'already broken on main', count: 5 };

describe('e2e-compare', () => {
  test('lists only the failures absent from the baseline as introduced', () => {
    const output = run(
      { total: 5, tests: [MINE, THEIRS] },
      { total: 5, tests: [{ ...THEIRS, count: 4 }] },
    );
    expect(output).toContain('Introduced by this branch');
    expect(output).toContain('`new.spec.ts:1`');
    // The shared one is disclosed, but under "also failing on main".
    const introduced = output.slice(0, output.indexOf('<details'));
    expect(introduced).not.toContain('old.spec.ts:2');
    expect(output).toContain('Also failing on `main`');
    expect(output).toContain('| `old.spec.ts:2` | 5/5 | 4/5 |');
  });

  test('says nothing was introduced rather than going silent', () => {
    const output = run({ total: 5, tests: [THEIRS] }, { total: 5, tests: [THEIRS] });
    expect(output).toContain('**Nothing.** Every failure below also fails on `main`');
  });

  test('a missing baseline is unattributed, never blamed on the branch', () => {
    const output = run({ total: 5, tests: [MINE] });
    expect(output).toContain('No `main` baseline was available');
    expect(output).toContain('listed as unattributed rather than blamed on this branch');
    // The heading must not claim authorship without evidence.
    expect(output).not.toContain('Introduced by this branch');
    expect(output).toContain('Failing here');
  });

  test('reports a clean branch', () => {
    const output = run({ total: 5, tests: [] }, { total: 5, tests: [] });
    expect(output).toContain('No failures in any sample.');
  });

  test('notes baseline failures that did not reproduce here', () => {
    const output = run({ total: 5, tests: [] }, { total: 5, tests: [THEIRS] });
    expect(output).toContain('1 test(s) that fail on `main` did not fail here');
  });

  test('carries the marker the workflow updates its comment by', () => {
    expect(run({ total: 5, tests: [] }, { total: 5, tests: [] })).toContain('<!-- e2e-compare -->');
  });
});
