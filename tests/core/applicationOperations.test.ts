import { describe, expect, test } from 'bun:test';
import { createApplicationOperations } from '../../src/main/hostDomain/applicationOperations';
import {
  APPLICATION_INSPECT_OUTPUT_SCHEMA,
  APPLICATION_MANAGE_OUTPUT_SCHEMA,
  DIAGNOSTICS_INSPECT_OUTPUT_SCHEMA,
  DIAGNOSTICS_MANAGE_OUTPUT_SCHEMA,
  type ApplicationOperationCaller,
} from '../../src/core/applicationOperations';
import { createBundledApplicationReleaseResolver } from '../../src/main/hostDomain/bundledApplicationRelease';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';
import { createApplicationTools } from '../../src/main/agent/capabilities/applicationTools';

const caller: ApplicationOperationCaller = {
  origin: { kind: 'agent', threadId: 'thread', turnId: 'turn', itemId: 'item' },
  authorize: async () => undefined,
};

function operations(overrides: Partial<Parameters<typeof createApplicationOperations>[0]> = {}) {
  let checked = 0;
  let opened: Array<'release' | 'download' | undefined> = [];
  const updates = {
    view: async () => ({
      currentVersion: '0.1.0', automaticChecksEnabled: true, phase: 'idle' as const,
      lastSuccessfulCheckAt: null, availableRelease: { version: '0.2.0', publishedAt: '2026-01-01T00:00:00.000Z', note: null, downloadAvailable: true }, manualError: null,
    }),
    checkExplicitly: async () => { checked += 1; return await updates.view(); },
    openAvailableUpdate: async (input: { destination?: 'release' | 'download' } = {}) => {
      opened.push(input.destination);
      return { ok: true as const, destination: input.destination ?? 'download' as const };
    },
  };
  const result = createApplicationOperations({
    updates,
    appInfo: async () => ({ name: 'Tenon', version: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '1', chrome: '1', node: '1' }),
    bundledRelease: async () => ({
      version: '0.1.0', date: '2026-01-01', note: 'Current release.', noteTruncated: false,
      changelogUrl: 'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-01-01',
    }),
    diagnostics: { readRecords: async () => [] },
    openExternal: async () => undefined,
    revealDiagnostics: async () => ({ ok: true, path: '/tmp/diagnostic.log' }),
    exportDiagnostics: async () => ({ ok: true, path: '/tmp/export.json' }),
    ...overrides,
  });
  return { result, get checked() { return checked; }, opened };
}

describe('application and diagnostics operations', () => {
  test('separates cached inspection from an explicit fresh update check', async () => {
    const fixture = operations();
    await fixture.result.inspect({ request: { operation: 'updates' } }, caller);
    expect(fixture.checked).toBe(0);
    await fixture.result.manage({ request: { operation: 'check_updates' } }, caller);
    expect(fixture.checked).toBe(1);
  });

  test('resolves bounded bundled release information with About fallback semantics', async () => {
    const resolve = createBundledApplicationReleaseResolver(`## [Unreleased]\n\nPrivate train.\n\n### Internal\n\n- Work.\n\n## [0.1.0] - 2026-01-01\n\nCurrent release.\n\n### Added\n\n- Detail.`);
    expect(resolve('0.1.0')).toMatchObject({
      version: '0.1.0',
      date: '2026-01-01',
      note: 'Current release.',
      noteTruncated: false,
      changelogUrl: 'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-01-01',
    });
    expect(resolve('0.2.0')?.version).toBe('0.1.0');

    const inspected = await operations().result.inspect({ request: { operation: 'release' } }, caller);
    expect(inspected).toMatchObject({
      operation: 'release',
      release: { version: '0.1.0', note: 'Current release.' },
    });
  });

  test('opens only validated release destinations', async () => {
    const fixture = operations();
    await fixture.result.manage({ request: { operation: 'open_destination', destination: 'release' } }, caller);
    await fixture.result.manage({ request: { operation: 'open_destination', destination: 'download' } }, caller);
    expect(fixture.opened).toEqual(['release', 'download']);
    await expect(fixture.result.manage({ request: { operation: 'open_destination', destination: 'https://example.com' } }, caller)).rejects.toThrow();
  });

  test('routes diagnostics reveal and export without accepting a path', async () => {
    const fixture = operations();
    await expect(fixture.result.diagnosticsManage({ request: { operation: 'reveal' } }, caller)).resolves.toMatchObject({ ok: true, path: '/tmp/diagnostic.log' });
    await expect(fixture.result.diagnosticsManage({ request: { operation: 'export' } }, caller)).resolves.toMatchObject({ ok: true, path: '/tmp/export.json' });
    await expect(fixture.result.diagnosticsManage({ request: { operation: 'export', path: '/tmp/arbitrary.json' } }, caller)).rejects.toThrow();
  });

  test('maps update and diagnostics domain failures to model-visible failure outcomes', async () => {
    const fixture = operations({
      updates: {
        view: async () => updateView(null),
        checkExplicitly: async () => updateView('timeout'),
        openAvailableUpdate: async () => ({ ok: false, error: 'unavailable' }),
      },
      revealDiagnostics: async () => ({ ok: false, error: 'private host detail' }),
      exportDiagnostics: async () => ({ ok: false, canceled: true }),
    });
    const tools = createApplicationTools(fixture.result, () => caller);
    const execute = async (name: string, input: unknown) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing ${name}`);
      return tool.execute('item', input as never);
    };

    const check = await execute('application_manage', { request: { operation: 'check_updates' } });
    expect(check.outcome).toEqual({
      ok: false,
      error: { code: 'update_check_timeout', message: 'The fresh update check timed out.' },
    });
    expect(check.data).toMatchObject({ result: { updates: { availableRelease: { version: '0.2.0' }, manualError: 'timeout' } } });
    expect(check.instructions).toContain('Cached update state');

    const open = await execute('application_manage', { request: { operation: 'open_update' } });
    expect(open.outcome).toMatchObject({ ok: false, error: { code: 'update_unavailable' } });

    const reveal = await execute('diagnostics_manage', { request: { operation: 'reveal' } });
    expect(reveal.outcome).toMatchObject({ ok: false, error: { code: 'diagnostics_reveal_failed' } });
    const exported = await execute('diagnostics_manage', { request: { operation: 'export' } });
    expect(exported.outcome).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(exported.instructions).toContain('Do not retry');
  });

  test('declares closed, bounded output data for every application operation tool', () => {
    const validate = (schema: object) => compileToolParameters(schema as never);
    const cases = [
      {
        validator: validate(APPLICATION_INSPECT_OUTPUT_SCHEMA),
        valid: { result: { operation: 'info', app: appInfo() } },
        missing: { result: { operation: 'info', app: { ...appInfo(), node: undefined } } },
        mistyped: { result: { operation: 'info', app: { ...appInfo(), version: 1 } } },
        oversized: { result: { operation: 'info', app: { ...appInfo(), name: 'x'.repeat(257) } } },
        unknown: { result: { operation: 'info', app: { ...appInfo(), privateBuild: 'secret' } } },
      },
      {
        validator: validate(APPLICATION_MANAGE_OUTPUT_SCHEMA),
        valid: { result: { operation: 'open_destination', destination: 'help', opened: true } },
        missing: { result: { operation: 'open_destination', destination: 'help' } },
        mistyped: { result: { operation: 'open_destination', destination: 'help', opened: 'yes' } },
        oversized: { result: { operation: 'check_updates', updates: { ...updateView(null), currentVersion: 'x'.repeat(129) } } },
        unknown: { result: { operation: 'open_destination', destination: 'help', opened: true, url: 'https://example.com' } },
      },
      {
        validator: validate(DIAGNOSTICS_INSPECT_OUTPUT_SCHEMA),
        valid: { result: diagnosticsStatus() },
        missing: { result: { ...diagnosticsStatus(), severityCounts: undefined } },
        mistyped: { result: { ...diagnosticsStatus(), recordCount: '1' } },
        oversized: { result: { ...diagnosticsStatus(), operation: 'x'.repeat(257) } },
        unknown: { result: { ...diagnosticsStatus(), privateLog: 'private data' } },
      },
      {
        validator: validate(DIAGNOSTICS_MANAGE_OUTPUT_SCHEMA),
        valid: { result: { operation: 'export', ok: true, path: '/tmp/export.json' } },
        missing: { result: { operation: 'export', ok: true } },
        mistyped: { result: { operation: 'export', ok: true, path: 42 } },
        oversized: { result: { operation: 'export', ok: true, path: 'x'.repeat(4_097) } },
        unknown: { result: { operation: 'export', ok: true, path: '/tmp/export.json', uploaded: true } },
      },
    ];
    for (const item of cases) {
      expect(item.validator.Check(item.valid)).toBe(true);
      expect(item.validator.Check(item.missing)).toBe(false);
      expect(item.validator.Check(item.mistyped)).toBe(false);
      expect(item.validator.Check(item.oversized)).toBe(false);
      expect(item.validator.Check(item.unknown)).toBe(false);
    }
  });
});

function appInfo() {
  return { name: 'Tenon', version: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '1', chrome: '1', node: '1' };
}

function updateView(manualError: 'timeout' | null) {
  return {
    currentVersion: '0.1.0', automaticChecksEnabled: true, phase: 'idle' as const,
    lastSuccessfulCheckAt: null,
    availableRelease: { version: '0.2.0', publishedAt: '2026-01-01T00:00:00.000Z', note: null, downloadAvailable: true },
    manualError,
  };
}

function diagnosticsStatus() {
  return {
    operation: 'status', hasRecords: true, recordCount: 1, latestAt: 1,
    severityCounts: { warn: 1, error: 0, fatal: 0 },
  };
}
