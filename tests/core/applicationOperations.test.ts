import { describe, expect, test } from 'bun:test';
import { createApplicationOperations } from '../../src/main/hostDomain/applicationOperations';
import type { ApplicationOperationCaller } from '../../src/core/applicationOperations';

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
});
