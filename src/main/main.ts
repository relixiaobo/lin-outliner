import { app, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '../core/brand';
import {
  serializeUnknownError,
  type ErrorReport,
} from '../core/errorObservability';
import {
  ASSET_URL_SCHEME,
  PREVIEW_LOCAL_URL_SCHEME,
} from '../core/assets';
import { createDesktopHost } from './desktopHost';
import { DiagnosticLogStore } from './diagnosticLog';
import { createTransportOwner, disposeTransportOwners, type TransportOwner } from './hostTransport/ownership';
import { resolveUserDataDir } from './userDataPath';

app.setName(APP_NAME);

const resolvedUserDataDir = resolveUserDataDir({
  envOverride: process.env.ELECTRON_USER_DATA_DIR,
  isPackaged: app.isPackaged,
  home: app.getPath('home'),
  appData: app.getPath('appData'),
  appName: APP_NAME,
});
app.setPath('userData', resolvedUserDataDir);
console.log(`[startup] userData directory: ${resolvedUserDataDir}`);

const diagnosticLog = new DiagnosticLogStore(resolvedUserDataDir);

function reportError(report: ErrorReport): void {
  void diagnosticLog.reportError(report).catch((error) => {
    console.error('[diagnostics] failed to write diagnostic error', error);
  });
}

function installMainErrorHandlers(): TransportOwner {
  return createTransportOwner('main-error-handlers', (owner) => {
    const handleUnhandledRejection = (reason: unknown) => {
      const serialized = serializeUnknownError(reason);
      reportError({
        domain: 'uncaught',
        severity: 'fatal',
        code: 'unhandled-rejection',
        message: serialized.message ?? 'Unhandled promise rejection',
        context: { operation: 'unhandledRejection' },
        error: reason,
      });
    };
    process.on('unhandledRejection', handleUnhandledRejection);
    owner.add(() => process.removeListener('unhandledRejection', handleUnhandledRejection));

    const handleUncaughtException = (error: Error) => {
      console.error(error);
      void Promise.race([
        diagnosticLog
          .reportError({
            domain: 'uncaught',
            severity: 'fatal',
            code: 'uncaught-exception',
            message: error.message || 'Uncaught exception',
            context: { operation: 'uncaughtException' },
            error,
          })
          .then(() => diagnosticLog.flushNow({ reason: 'fatal', timeoutMs: 750 }).catch(() => undefined)),
        new Promise((resolve) => setTimeout(resolve, 750)),
      ]).finally(() => app.exit(1));
    };
    process.on('uncaughtException', handleUncaughtException);
    owner.add(() => process.removeListener('uncaughtException', handleUncaughtException));
  });
}

const mainErrorTransport = installMainErrorHandlers();

// Unsigned local/dev builds cannot present a stable signature to Chromium's
// os_crypt. This must be set before Electron readiness.
app.commandLine.appendSwitch('use-mock-keychain');

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_URL_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  // Only opaque, main-issued UUID tokens use this CORS-enabled scheme. It is
  // registered on the default app session, not the remote URL-preview partition.
  {
    scheme: PREVIEW_LOCAL_URL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  mainErrorTransport.dispose();
  app.quit();
} else {
  let appLifecycleTransport: TransportOwner | null = null;
  let mainEffectsReleased = false;
  const releaseMainEffects = () => {
    if (mainEffectsReleased) return;
    mainEffectsReleased = true;
    disposeTransportOwners('main-bootstrap', [appLifecycleTransport, mainErrorTransport]);
    appLifecycleTransport = null;
  };

  const desktopHost = createDesktopHost({
    userDataDir: resolvedUserDataDir,
    moduleDir: fileURLToPath(new URL('.', import.meta.url)),
    diagnosticLog,
    reportError,
    releaseBootstrapEffects: releaseMainEffects,
  });

  appLifecycleTransport = createTransportOwner('app-lifecycle-forwarding', (owner) => {
    const handleSecondInstance = () => desktopHost.focusSecondInstance();
    app.on('second-instance', handleSecondInstance);
    owner.add(() => app.removeListener('second-instance', handleSecondInstance));

    const handleAllWindowsClosed = () => desktopHost.allWindowsClosed();
    app.on('window-all-closed', handleAllWindowsClosed);
    owner.add(() => app.removeListener('window-all-closed', handleAllWindowsClosed));

    const handleBeforeQuit = (event: Electron.Event) => {
      event.preventDefault();
      void desktopHost.requestQuit().catch((error) => {
        reportError({
          domain: 'lifecycle',
          severity: 'error',
          code: 'quit-drain-failed',
          message: 'Quit coordination failed; the application remains open.',
          context: { operation: 'before-quit' },
          error,
        });
      });
    };
    app.on('before-quit', handleBeforeQuit);
    owner.add(() => app.removeListener('before-quit', handleBeforeQuit));
  });

  void app.whenReady()
    .then(() => desktopHost.start())
    .catch((error) => console.error(error));
}
