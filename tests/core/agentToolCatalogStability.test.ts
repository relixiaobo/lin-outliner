import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('canonical provider tool catalog', () => {
  test('passes the isolated byte-stability probe', async () => {
    const probe = Bun.spawn([
      process.execPath,
      'test',
      join(import.meta.dir, '..', 'fixtures', 'agentToolCatalogStability.test.ts'),
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
    expect(exitCode).toBe(0);
  });
});
