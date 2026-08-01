#!/usr/bin/env bun
/**
 * e2e-compare — subtracts `main`'s e2e baseline from a branch's, so "is this
 * failure mine?" is a set operation instead of a judgement call.
 *
 * Why this exists at all: the signal on `main` alone could not answer the
 * question it was built for. A gate runs the suite on a developer's machine
 * while the baseline was measured on a CI runner, and those disagree — on macOS
 * CI, four tests fail every time that pass locally, and the one test the board
 * had called `main`'s red baseline passes 5/5 there. Two environments give two
 * answers, so comparing across them proves nothing.
 *
 * The fix is not to make the environments match — that may not be achievable for
 * headless compositing — but to take BOTH measurements in the SAME one. The
 * branch and `main` each get five whole-suite samples on the same runner image,
 * and the difference is attributable.
 *
 * Reads two `e2e-classify --json` summaries. Exit code is always 0: this reports,
 * it does not gate.
 */

interface Summary {
  readonly total: number;
  readonly tests: readonly { readonly id: string; readonly title: string; readonly count: number }[];
}

function read(path: string): Summary {
  const parsed = JSON.parse(require('node:fs').readFileSync(path, 'utf8')) as Summary;
  return { total: parsed.total ?? 0, tests: parsed.tests ?? [] };
}

const [branchPath, baselinePath] = process.argv.slice(2);
if (!branchPath) {
  console.log('No branch summary — the comparison did not run. Investigate the workflow.');
  process.exit(0);
}

const branch = read(branchPath);
// A missing baseline is the honest "first run on a new workflow" case, and it
// must read as "cannot attribute", never as "everything here is yours".
const baseline = baselinePath ? read(baselinePath) : { total: 0, tests: [] };
const baselineById = new Map(baseline.tests.map((test) => [test.id, test]));
const branchById = new Map(branch.tests.map((test) => [test.id, test]));

const introduced = branch.tests.filter((test) => !baselineById.has(test.id));
const shared = branch.tests.filter((test) => baselineById.has(test.id));
const onlyOnMain = baseline.tests.filter((test) => !branchById.has(test.id));

const lines: string[] = [];
if (baselinePath === undefined) {
  lines.push('> No `main` baseline was available, so nothing below is attributed. '
    + 'Every failure is listed as unattributed rather than blamed on this branch.');
  lines.push('');
}
lines.push(`**${branch.total} samples on this branch`
  + `${baselinePath ? `, against ${baseline.total} on \`main\`` : ''}.**`);
lines.push('');

if (introduced.length === 0 && branch.tests.length === 0) {
  lines.push('No failures in any sample.');
} else {
  if (introduced.length > 0) {
    lines.push(`### ${baselinePath ? 'Introduced by this branch' : 'Failing here'}`);
    lines.push('');
    lines.push('| Test | Failed |');
    lines.push('| --- | --- |');
    for (const test of introduced) {
      lines.push(`| \`${test.id}\`<br>${test.title} | ${test.count}/${branch.total} |`);
    }
    lines.push('');
  } else if (baselinePath) {
    lines.push('### Introduced by this branch');
    lines.push('');
    lines.push('**Nothing.** Every failure below also fails on `main`.');
    lines.push('');
  }
  if (shared.length > 0) {
    lines.push('<details><summary>Also failing on `main` '
      + `(${shared.length}) — not this branch's</summary>\n`);
    lines.push('| Test | Branch | `main` |');
    lines.push('| --- | --- | --- |');
    for (const test of shared) {
      const base = baselineById.get(test.id);
      lines.push(`| \`${test.id}\` | ${test.count}/${branch.total} | ${base?.count ?? 0}/${baseline.total} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}
// Outside the branch above on purpose: a clean branch is exactly when "these
// fail on `main` but not here" matters most — it may be what the branch fixed.
if (onlyOnMain.length > 0) {
  lines.push(`_${onlyOnMain.length} test(s) that fail on \`main\` did not fail here — `
    + 'either fixed by this branch, or intermittent in both._');
  lines.push('');
}
lines.push('<!-- e2e-compare -->');
console.log(lines.join('\n'));
