import { describe, expect, test } from 'bun:test';
import { createDiagnosticsExportHost } from '../../src/main/hostPlatform/diagnosticsExportHost';
import { createApplicationOperations } from '../../src/main/hostDomain/applicationOperations';
import type { ApplicationOperationCaller } from '../../src/core/applicationOperations';
import { AgentToolFailure } from '../../src/main/agent/AgentToolFailure';

const environment = {
  appVersion: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '1', chrome: '1', node: '1', providerId: null,
};

describe('diagnostics export Host', () => {
  test('revalidates caller authority and Host/window lifetime after the save dialog', async () => {
    for (const invalidation of ['abort', 'revoke', 'release', 'window'] as const) {
      const abort = new AbortController();
      let available = true;
      let windowAvailable = true;
      let authorizeCount = 0;
      let writes = 0;
      let resolveSelection!: (selection: { canceled: boolean; filePath?: string }) => void;
      let markDialogEntered!: () => void;
      const selected = new Promise<{ canceled: boolean; filePath?: string }>((resolve) => { resolveSelection = resolve; });
      const dialogEntered = new Promise<void>((resolve) => { markDialogEntered = resolve; });
      const window = { isDestroyed: () => false };
      const caller: ApplicationOperationCaller = {
        origin: { kind: 'agent', threadId: 'thread', turnId: 'turn', itemId: 'item' },
        signal: abort.signal,
        authorize: async () => {
          authorizeCount += 1;
          if (invalidation === 'revoke' && authorizeCount === 2) {
            throw new AgentToolFailure('operation_unavailable', 'Authority was revoked.', 'Inspect current policy.');
          }
        },
      };
      const exporter = createDiagnosticsExportHost({
        available: () => available,
        operationWindow: () => windowAvailable ? window : null,
        defaultPath: () => '/tmp/default.json',
        selectPath: async () => { markDialogEntered(); return selected; },
        environment: async () => environment,
        writeExport: async (path) => { writes += 1; return path; },
      });
      const operation = applicationOperations(exporter);
      const running = operation.diagnosticsManage({ request: { operation: 'export' } }, caller);
      await dialogEntered;

      if (invalidation === 'abort') abort.abort();
      if (invalidation === 'release') available = false;
      if (invalidation === 'window') windowAvailable = false;
      resolveSelection({ canceled: false, filePath: '/tmp/selected.json' });

      await expect(running).rejects.toThrow();
      expect(writes).toBe(0);
      expect(authorizeCount).toBe(invalidation === 'abort' ? 1 : 2);
    }
  });

  test('keeps a native cancellation as cancellation without writing', async () => {
    let writes = 0;
    let authorizeCount = 0;
    const window = { isDestroyed: () => false };
    const exporter = createDiagnosticsExportHost({
      available: () => true,
      operationWindow: () => window,
      defaultPath: () => '/tmp/default.json',
      selectPath: async () => ({ canceled: true }),
      environment: async () => environment,
      writeExport: async (path) => { writes += 1; return path; },
    });
    const result = await applicationOperations(exporter).diagnosticsManage(
      { request: { operation: 'export' } },
      {
        origin: { kind: 'window', windowId: 1 },
        authorize: async () => { authorizeCount += 1; },
      },
    );

    expect(result).toEqual({ operation: 'export', ok: false, canceled: true });
    expect(authorizeCount).toBe(1);
    expect(writes).toBe(0);
  });
});

function applicationOperations(
  exportDiagnostics: ReturnType<typeof createDiagnosticsExportHost>,
) {
  return createApplicationOperations({
    updates: {
      view: async () => updateView(),
      checkExplicitly: async () => updateView(),
      openAvailableUpdate: async () => ({ ok: false, error: 'unavailable' }),
    },
    appInfo: async () => ({ name: 'Tenon', version: '0.1.0', platform: 'darwin', arch: 'arm64', electron: '1', chrome: '1', node: '1' }),
    bundledRelease: async () => null,
    diagnostics: { readRecords: async () => [] },
    openExternal: async () => undefined,
    revealDiagnostics: async () => ({ ok: false, error: 'unavailable' }),
    exportDiagnostics,
  });
}

function updateView() {
  return {
    currentVersion: '0.1.0', automaticChecksEnabled: true, phase: 'idle' as const,
    lastSuccessfulCheckAt: null, availableRelease: null, manualError: null,
  };
}
