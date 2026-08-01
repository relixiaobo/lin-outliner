import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The classifier behind the `main` e2e signal. It is worth testing because the
 * judgement it automates is one a human already got wrong here: four samples of
 * `file-attachments.spec.ts:178` all failed and it was boarded as deterministic,
 * then it passed twice in a row. A tool that reports the sample count and the
 * frequency is the fix; a tool that miscounts is worse than none.
 *
 * Shapes below are the real Playwright JSON reporter shape: `specs` nest inside
 * `suites`, and only a spec carries `ok`/`file`/`line`.
 */
const CLASSIFY = join(import.meta.dir, '../../scripts/e2e-classify.ts');

function sample(specs: readonly { file: string; line: number; title: string; ok: boolean }[]): string {
  return JSON.stringify({
    config: {},
    errors: [],
    stats: { expected: specs.filter((spec) => spec.ok).length, unexpected: specs.filter((spec) => !spec.ok).length },
    suites: specs.map((spec) => ({
      title: spec.file,
      file: spec.file,
      suites: [{
        title: 'group',
        file: spec.file,
        specs: [{ title: spec.title, file: spec.file, line: spec.line, ok: spec.ok }],
      }],
    })),
  });
}

async function classify(samples: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-classify-'));
  const paths = samples.map((body, index) => {
    const path = join(dir, `sample-${index}.json`);
    writeFileSync(path, body);
    return path;
  });
  const result = Bun.spawnSync(['bun', CLASSIFY, ...paths]);
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

const RED = { file: 'a.spec.ts', line: 10, title: 'always broken', ok: false };
const GREEN = { file: 'a.spec.ts', line: 10, title: 'always broken', ok: true };
const FLAKY = { file: 'b.spec.ts', line: 20, title: 'sometimes broken', ok: false };
const FLAKY_OK = { file: 'b.spec.ts', line: 20, title: 'sometimes broken', ok: true };

describe('e2e-classify', () => {
  test('reports green only when every sample is green', async () => {
    const output = await classify([sample([GREEN]), sample([GREEN]), sample([GREEN])]);
    expect(output).toContain('3 full-suite samples');
    expect(output).toContain('is **green**');
  });

  test('separates a deterministic failure from an intermittent one by frequency', async () => {
    const output = await classify([
      sample([RED, FLAKY]),
      sample([RED, FLAKY_OK]),
      sample([RED, FLAKY_OK]),
    ]);
    expect(output).toContain('| `a.spec.ts:10`');
    expect(output).toContain('| 3/3 | **deterministic** |');
    expect(output).toContain('| `b.spec.ts:20`');
    expect(output).toContain('| 1/3 | intermittent |');
    // The lesson the board carries: a changing failing set is one problem.
    expect(output).toContain('Do not board them individually');
  });

  test('a test that passes in one sample is never called deterministic', async () => {
    // The exact mistake this replaces: N-1 failures read as "always".
    const output = await classify([sample([RED]), sample([RED]), sample([RED]), sample([GREEN])]);
    expect(output).toContain('| 3/4 | intermittent |');
    expect(output).not.toContain('deterministic');
  });

  test('an unreadable sample is excluded and counted, not read as green', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-classify-bad-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(good, sample([RED]));
    writeFileSync(bad, 'not json');
    const result = Bun.spawnSync(['bun', CLASSIFY, good, bad]);
    const output = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output).toContain('1 full-suite samples');
    expect(output).toContain('1 sample report(s) could not be read');
    expect(output).toContain('| 1/1 | **deterministic** |');
  });

  test('no reports at all blames the workflow, not `main`', async () => {
    const result = Bun.spawnSync(['bun', CLASSIFY]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('Investigate the workflow, not `main`');
  });
});
