import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../src/core/agent/tools';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';

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

  test('compiles every static model-tool schema', () => {
    const failures: string[] = [];
    for (const contract of MODEL_TOOL_CATALOG) {
      if (contract.inputSchema === null) continue;
      try {
        compileToolParameters(contract.inputSchema as never);
      } catch (error) {
        failures.push(`${canonicalModelToolKey(contract.identity)}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
