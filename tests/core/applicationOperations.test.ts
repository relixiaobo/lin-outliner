import { describe, expect, test } from 'bun:test';
import { createApplicationOperations } from '../../src/main/hostDomain/applicationOperations';
import { APPLICATION_DESTINATIONS, type ApplicationOperationCaller } from '../../src/core/applicationOperations';
import { createBundledApplicationReleaseResolver } from '../../src/main/hostDomain/bundledApplicationRelease';

const caller: ApplicationOperationCaller = {
  origin: { kind: 'window', windowId: 1 },
  authorize: async () => undefined,
};
const app = { name: 'Tenon', version: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '1', chrome: '1', node: '1' };

function operations(overrides: Partial<Parameters<typeof createApplicationOperations>[0]> = {}) {
  return createApplicationOperations({
    appInfo: async () => app,
    bundledRelease: async () => ({ version: '0.1.0', date: '2026-01-01', note: 'Current release.', noteTruncated: false,
      changelogUrl: 'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-01-01' }),
    openExternal: async () => undefined,
    revealDiagnostics: async () => ({ ok: true, path: '/tmp/diagnostic.log' }),
    exportDiagnostics: async () => ({ ok: true, path: '/tmp/export.json' }),
    ...overrides,
  });
}

describe('application UI services', () => {
  test('reads About information and bundled release notes with the installed-version fallback', async () => {
    const resolve = createBundledApplicationReleaseResolver(`## [Unreleased]\n\nPrivate train.\n\n### Internal\n\n- Work.\n\n## [0.1.0] - 2026-01-01\n\nCurrent release.\n\n### Added\n\n- Detail.`);
    expect(resolve('0.1.0')).toMatchObject({ version: '0.1.0', date: '2026-01-01', note: 'Current release.', noteTruncated: false });
    expect(resolve('0.2.0')?.version).toBe('0.1.0');
    expect(await operations().info()).toEqual(app);
    expect(await operations().release()).toEqual(resolve('0.1.0'));
  });

  test('opens only fixed support destinations', async () => {
    const opened: string[] = [];
    const service = operations({ openExternal: async (url) => { opened.push(url); } });
    await service.openDestination('help');
    await service.openDestination('issues');
    expect(opened).toEqual([APPLICATION_DESTINATIONS.help, APPLICATION_DESTINATIONS.issues]);
    await expect(service.openDestination('https://example.com' as never)).rejects.toThrow('Only fixed');
    await expect(service.openDestination('toString' as never)).rejects.toThrow('Only fixed');
  });

  test('preserves successful, failed, and canceled diagnostics outcomes', async () => {
    expect(await operations().diagnostics('reveal', caller)).toEqual({ operation: 'reveal', ok: true, path: '/tmp/diagnostic.log' });
    expect(await operations().diagnostics('export', caller)).toEqual({ operation: 'export', ok: true, path: '/tmp/export.json' });
    const service = operations({ revealDiagnostics: async () => ({ ok: false, error: 'Unavailable' }),
      exportDiagnostics: async () => ({ ok: false, canceled: true }) });
    expect(await service.diagnostics('reveal', caller)).toEqual({ operation: 'reveal', ok: false, error: 'Unavailable' });
    expect(await service.diagnostics('export', caller)).toEqual({ operation: 'export', ok: false, canceled: true });
  });

  test('a lost caller cannot begin diagnostics work', async () => {
    let started = false;
    const service = operations({ exportDiagnostics: async () => { started = true; return { ok: true, path: '/tmp/export.json' }; } });
    await expect(service.diagnostics('export', { ...caller, authorize: async () => { throw new Error('Window closed'); } })).rejects.toThrow('Window closed');
    expect(started).toBe(false);
  });
});
