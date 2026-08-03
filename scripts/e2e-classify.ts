#!/usr/bin/env bun
/**
 * e2e-classify — turns N independent full-suite Playwright runs into one verdict.
 *
 * Why N runs and not one: a single run cannot tell a red baseline from a flake.
 * Four full runs at the #475 gate produced a DIFFERENT failing set each time, and
 * only one test failed in all four. A signal that reports one sample would have
 * called three intermittent tests "broken" and, on a lucky run, called the broken
 * one "fine".
 *
 * Why whole-suite samples and not `--repeat-each`: the failures we are hunting are
 * order/state-dependent — `flaky-thread-model-menu-focus-e2e` passes solo and fails
 * in a full run. Repeating a test in place destroys the context that produces it.
 *
 * Input: Playwright JSON reports, one per sample, passed as file arguments.
 * Output: a Markdown verdict on stdout; exit code is always 0 — this classifies,
 * it does not gate. Its own failure mode must be "no report", not "main is red".
 */

interface PlaywrightSpec {
  readonly title?: string;
  readonly file?: string;
  readonly line?: number;
  readonly ok?: boolean;
  readonly specs?: readonly PlaywrightSpec[];
  readonly suites?: readonly PlaywrightSpec[];
}

interface TestIdentity {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly title: string;
}

/** Every failing leaf spec, flattened out of the nested suite tree. */
function collectFailures(node: PlaywrightSpec, trail: readonly string[]): readonly TestIdentity[] {
  const here = node.title ? [...trail, node.title] : trail;
  const nested = [
    ...(node.suites ?? []).flatMap((child) => collectFailures(child, here)),
    ...(node.specs ?? []).flatMap((child) => collectFailures(child, here)),
  ];
  // A leaf spec carries `ok`; suites do not. `ok === false` is the only failure
  // signal we trust — `undefined` on a suite must not be read as a failure.
  if (node.ok === false && node.file !== undefined) {
    const file = node.file;
    const line = node.line ?? 0;
    return [...nested, { id: `${file}:${line}`, file, line, title: here.join(' › ') }];
  }
  return nested;
}

function readReport(path: string): readonly TestIdentity[] {
  const report = JSON.parse(require('node:fs').readFileSync(path, 'utf8')) as {
    readonly suites?: readonly PlaywrightSpec[];
  };
  const failures = (report.suites ?? []).flatMap((suite) => collectFailures(suite, []));
  // One sample counts a test once however many times its id appears.
  return [...new Map(failures.map((failure) => [failure.id, failure])).values()];
}

const argv = process.argv.slice(2);
const emitJson = argv.includes('--json');
const reportPaths = argv.filter((arg) => arg !== '--json');
if (emitJson && reportPaths.length === 0) {
  console.log(JSON.stringify({ total: 0, tests: [] }));
  process.exit(0);
}
if (reportPaths.length === 0) {
  console.log('No sample reports were produced — the signal did not run. Investigate the workflow, not `main`.');
  process.exit(0);
}

const samples = reportPaths.map((path) => {
  try {
    return { path, failures: readReport(path), read: true };
  } catch (error) {
    return { path, failures: [] as readonly TestIdentity[], read: false, error };
  }
});
const usable = samples.filter((sample) => sample.read);
const total = usable.length;

const byTest = new Map<string, { identity: TestIdentity; count: number }>();
for (const sample of usable) {
  for (const failure of sample.failures) {
    const existing = byTest.get(failure.id);
    if (existing) existing.count += 1;
    else byTest.set(failure.id, { identity: failure, count: 1 });
  }
}

const ranked = [...byTest.values()].sort((a, b) => (
  b.count - a.count || a.identity.id.localeCompare(b.identity.id)
));
const deterministic = ranked.filter((entry) => entry.count === total);
const intermittent = ranked.filter((entry) => entry.count < total);

if (emitJson) {
  // The machine-readable form the branch↔baseline comparison reads. Frequencies,
  // not verdicts: "deterministic" is a judgement about one environment, and the
  // comparison's job is to hold two environments' numbers side by side.
  console.log(JSON.stringify({
    total,
    tests: ranked.map((entry) => ({
      id: entry.identity.id,
      title: entry.identity.title,
      count: entry.count,
    })),
  }));
  process.exit(0);
}

const lines: string[] = [];
lines.push(`**${total} full-suite samples.**`);
if (total !== samples.length) {
  lines.push('');
  lines.push(`> ${samples.length - total} sample report(s) could not be read and were excluded.`);
}
lines.push('');
if (ranked.length === 0) {
  lines.push(`\`main\` is **green** across all ${total} samples.`);
} else {
  lines.push(`| Test | Failed | Verdict |`);
  lines.push(`| --- | --- | --- |`);
  for (const entry of ranked) {
    const verdict = entry.count === total ? '**deterministic**' : 'intermittent';
    lines.push(`| \`${entry.identity.id}\`<br>${entry.identity.title} | ${entry.count}/${total} | ${verdict} |`);
  }
  lines.push('');
  if (deterministic.length > 0) {
    lines.push(`**${deterministic.length} deterministic failure(s)** — these are \`main\`'s, and every PR gate `
      + `pays to re-prove they are not its own until they are fixed.`);
  }
  if (intermittent.length > 0) {
    lines.push(`**${intermittent.length} intermittent failure(s)** — a failing set that changes between `
      + `samples is one problem, not several. Do not board them individually.`);
  }
}
console.log(lines.join('\n'));
