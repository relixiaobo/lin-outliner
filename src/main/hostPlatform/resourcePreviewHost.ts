import { dialog, session, shell, type BrowserWindow, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { normalizePreviewHttpUrl } from '../../core/preview';
import { ASSET_URL_SCHEME, PREVIEW_LOCAL_URL_SCHEME } from '../../core/assets';
import {
  LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL,
  type ClearPreviewTranslationCacheResult,
} from '../../core/urlPageTranslation';
import {
  httpReferrerForUrlPreview,
  URL_PREVIEW_WEBVIEW_PARTITION,
  type ClearUrlPreviewDataResult,
} from '../../core/urlPreviewSession';
import type { ErrorReport } from '../../core/errorObservability';
import type { Locale } from '../../core/locale';
import { getMessages } from '../../core/i18n';
import { isRendererPermissionAllowed } from '../rendererPermissions';
import {
  clearUrlPreviewSessionData,
  configureUrlPreviewSession,
  createUrlPreviewWindowOpenHandler,
  flushUrlPreviewSession,
} from '../urlPreviewSession';
import { PageTranslationService, pageTranslationErrorReport } from '../pageTranslation';
import { PreviewTranslationCacheStore } from '../previewTranslationCacheStore';
import { clearPreviewTranslationCacheFromSettings } from '../previewTranslationCacheClear';
import { LocalFilePreviewStreamRegistry } from '../localFilePreviewStream';
import { LinkedFileGrantStore } from '../linkedFileGrantStore';
import type { PreviewCommandContext } from '../previewSource';
import {
  createNativeLocalFileHost,
  type NativeLocalFileHost,
  type NativeLocalFileHostOptions,
} from './nativeLocalFileHost';

const RENDERER_SCRIPT_SRC = "script-src 'self'";
const VITE_REACT_REFRESH_PREAMBLE_CSP_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";
const RENDERER_CSP_DIRECTIVES = [
  "default-src 'self'",
  RENDERER_SCRIPT_SRC,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
  `media-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src blob:",
  "base-uri 'self'",
  "form-action 'none'",
];
const RENDERER_CSP = [
  ...RENDERER_CSP_DIRECTIVES,
  `connect-src 'self' ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}:`,
].join('; ');

export interface ResourcePreviewHostOptions {
  readonly userDataDir: string;
  readonly rendererDevUrl?: string;
  readonly previewRoots: () => readonly string[];
  readonly localFileRoots: () => readonly string[];
  readonly resolveAttachmentFile: NativeLocalFileHostOptions['resolveAttachmentFile'];
  readonly resolveResourceFile: NativeLocalFileHostOptions['resolveResourceFile'];
  readonly reportError: (report: ErrorReport) => void;
}

export interface ResourcePreviewHost {
  readonly rendererDevUrl: string | null;
  readonly rendererDevOrigin: string | null;
  readonly translation: {
    handle: PageTranslationService['handle'];
    dispose(): void;
  };
  readonly streams: {
    issue: LocalFilePreviewStreamRegistry['issue'];
    issuePath: LocalFilePreviewStreamRegistry['issuePath'];
    issueExactPath: LocalFilePreviewStreamRegistry['issueExactPath'];
    issueExactFile: LocalFilePreviewStreamRegistry['issueExactFile'];
    serve: LocalFilePreviewStreamRegistry['serve'];
  };
  readonly linkedFileGrant: NonNullable<PreviewCommandContext['linkedFileGrant']>;
  readonly localFiles: NativeLocalFileHost;
  initializeSession(): Session;
  previewSession(): Session | null;
  openExternal(url: string): boolean;
  configurePreviewSession(): () => void;
  hardenWebContents(contents: WebContents): void;
  configureDefaultSessionSecurity(): () => void;
  clearWebsiteData(
    event: IpcMainInvokeEvent,
    settingsWindow: BrowserWindow | null,
    locale: Locale,
  ): Promise<ClearUrlPreviewDataResult>;
  clearTranslationCache(
    event: IpcMainInvokeEvent,
    settingsWindow: BrowserWindow | null,
    locale: Locale,
  ): Promise<ClearPreviewTranslationCacheResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createResourcePreviewHost(options: ResourcePreviewHostOptions): ResourcePreviewHost {
  const rendererDevUrl = options.rendererDevUrl ?? null;
  const rendererDevOrigin = rendererDevUrl ? safeOrigin(rendererDevUrl) : null;
  const rendererDevCspDirectives = RENDERER_CSP_DIRECTIVES.map((directive) =>
    directive === RENDERER_SCRIPT_SRC
      ? `${RENDERER_SCRIPT_SRC} ${VITE_REACT_REFRESH_PREAMBLE_CSP_HASH}`
      : directive,
  );
  const rendererDevCsp = rendererDevOrigin
    ? [
        ...rendererDevCspDirectives,
        `connect-src 'self' ${ASSET_URL_SCHEME}: ${PREVIEW_LOCAL_URL_SCHEME}: ${rendererDevOrigin} ${rendererDevOrigin.replace(/^http/i, 'ws')}`,
      ].join('; ')
    : null;
  const previewTranslationCache = new PreviewTranslationCacheStore(
    join(options.userDataDir, 'preview-translation-cache'),
    {
      onError: (operation) => options.reportError({
        domain: 'page-translation',
        severity: 'warn',
        code: `preview-translation-cache-${operation}-failed`,
        message: 'Preview translation cache operation failed.',
        context: { operation: `translation-cache-${operation}` },
      }),
    },
  );
  const pageTranslation = new PageTranslationService({
    cache: previewTranslationCache,
    onError: () => options.reportError(pageTranslationErrorReport()),
  });
  const streams = new LocalFilePreviewStreamRegistry(options.previewRoots);
  const linkedFileGrants = new LinkedFileGrantStore(join(options.userDataDir, 'linked-file-grants.json'));
  const localFiles = createNativeLocalFileHost({
    trustedRoots: options.localFileRoots,
    resolveAttachmentFile: options.resolveAttachmentFile,
    resolveResourceFile: options.resolveResourceFile,
  });
  const previewGuests = new Set<WebContents>();
  let previewSession: Session | null = null;
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    pageTranslation.dispose();
    closePromise = Promise.all([
      localFiles.close(),
      previewTranslationCache.flushNow(),
      flushUrlPreviewSession(previewSession),
      streams.close(),
    ]).then(() => undefined);
    return closePromise;
  };

  const host: ResourcePreviewHost = {
    rendererDevUrl,
    rendererDevOrigin,
    translation: {
      handle: (...args) => pageTranslation.handle(...args),
      dispose: () => pageTranslation.dispose(),
    },
    streams: {
      issue: (...args) => streams.issue(...args),
      issuePath: (...args) => streams.issuePath(...args),
      issueExactPath: (...args) => streams.issueExactPath(...args),
      issueExactFile: (...args) => streams.issueExactFile(...args),
      serve: (...args) => streams.serve(...args),
    },
    linkedFileGrant: {
      resolve: (...args) => linkedFileGrants.resolve(...args),
      authorize: (...args) => linkedFileGrants.authorize(...args),
      admitSelectedFile: (...args) => linkedFileGrants.admitSelectedFile(...args),
      revoke: (...args) => linkedFileGrants.revoke(...args),
    },
    localFiles,
    initializeSession: () => {
      if (!previewSession) previewSession = session.fromPartition(URL_PREVIEW_WEBVIEW_PARTITION);
      return previewSession;
    },
    previewSession: () => previewSession,
    openExternal: openExternalUrl,
    configurePreviewSession: () => {
      if (!previewSession) throw new Error('URL Preview session is unavailable before initialization.');
      return configureUrlPreviewSession(previewSession);
    },
    hardenWebContents: (contents) => hardenWebContents(contents, () => previewSession, previewGuests, options),
    configureDefaultSessionSecurity: () => configureDefaultSessionSecurity(
      rendererDevOrigin,
      rendererDevCsp,
    ),
    clearWebsiteData: async (event, settingsWindow, locale) => {
      if (!settingsWindow || settingsWindow.isDestroyed()
        || event.sender !== settingsWindow.webContents || !previewSession) {
        return { status: 'failed', error: 'unavailable' };
      }
      const labels = getMessages(locale).settings.general;
      const confirmation = await dialog.showMessageBox(settingsWindow, {
        type: 'warning',
        title: labels.websiteDataClearConfirmTitle,
        message: labels.websiteDataClearConfirmMessage,
        detail: labels.websiteDataClearConfirmDetail,
        buttons: [labels.websiteDataClearConfirmAction, labels.websiteDataCancelAction],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return { status: 'canceled' };
      try {
        await clearUrlPreviewSessionData(previewSession);
        for (const guest of [...previewGuests]) {
          if (guest.isDestroyed()) {
            previewGuests.delete(guest);
            continue;
          }
          guest.reloadIgnoringCache();
        }
        return { status: 'cleared' };
      } catch (error) {
        options.reportError({
          domain: 'url-preview',
          severity: 'error',
          code: 'url-preview-clear-data',
          message: 'URL Preview website data could not be cleared',
          context: { operation: 'clear-data' },
          error,
        });
        return { status: 'failed', error: 'clear-failed' };
      }
    },
    clearTranslationCache: (event, settingsWindow, locale) => (
      clearPreviewTranslationCacheFromSettings(event, {
        cache: previewTranslationCache,
        getSettingsWindow: () => settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null,
        labels: () => getMessages(locale).settings.general,
        showMessageBox: (window, messageOptions) => dialog.showMessageBox(window, messageOptions),
      })
    ),
    flush: () => Promise.all([
      previewTranslationCache.flushNow(),
      flushUrlPreviewSession(previewSession),
    ]).then(() => undefined),
    close,
  };
  return host;
}

function hardenWebContents(
  contents: WebContents,
  previewSession: () => Session | null,
  previewGuests: Set<WebContents>,
  options: ResourcePreviewHostOptions,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isAppDocumentUrl(url, options.rendererDevUrl ?? null)) return;
    event.preventDefault();
    openExternalUrl(url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : '';
    const normalizedSrc = normalizePreviewHttpUrl(src);
    if (!normalizedSrc) {
      event.preventDefault();
      return;
    }
    delete params.preload;
    delete params.webpreferences;
    delete params.httpreferrer;
    delete webPreferences.preload;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.partition = URL_PREVIEW_WEBVIEW_PARTITION;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.plugins = false;
    webPreferences.safeDialogs = true;
    webPreferences.disableDialogs = true;
    webPreferences.navigateOnDragDrop = false;
    params.partition = URL_PREVIEW_WEBVIEW_PARTITION;
    params.src = normalizedSrc;
    const trustedHttpReferrer = httpReferrerForUrlPreview(normalizedSrc);
    if (trustedHttpReferrer) params.httpreferrer = trustedHttpReferrer;
  });
  contents.on('did-attach-webview', (_event, webContents) => {
    if (!previewSession() || webContents.session !== previewSession()) {
      webContents.close();
      return;
    }
    previewGuests.add(webContents);
    webContents.once('destroyed', () => previewGuests.delete(webContents));
    webContents.setWindowOpenHandler(createUrlPreviewWindowOpenHandler(webContents, (error) => {
      options.reportError({
        domain: 'url-preview',
        severity: 'warn',
        code: 'url-preview-popup-navigation',
        message: 'URL Preview could not route a new-window request in place',
        context: { operation: 'popup-navigation' },
        error,
      });
    }));
    const guardWebviewNavigation = (event: Electron.Event, url: string) => {
      if (normalizePreviewHttpUrl(url)) return;
      event.preventDefault();
    };
    webContents.on('will-navigate', guardWebviewNavigation);
    webContents.on('will-redirect', guardWebviewNavigation);
    webContents.on('before-input-event', (event, input) => {
      const isTranslationShortcut = input.type === 'keyDown'
        && !input.isAutoRepeat
        && input.alt
        && !input.control
        && !input.meta
        && !input.shift
        && (input.code === 'KeyA' || input.key.toLowerCase() === 'a');
      if (!isTranslationShortcut) return;
      event.preventDefault();
      if (!contents.isDestroyed()) {
        contents.send(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, webContents.id);
      }
    });
  });
}

function configureDefaultSessionSecurity(
  rendererDevOrigin: string | null,
  rendererDevCsp: string | null,
): () => void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isRendererPermissionAllowed(permission));
  });
  defaultSession.setPermissionCheckHandler((_contents, permission) => isRendererPermissionAllowed(permission));
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    const csp = details.url.startsWith('file:')
      ? RENDERER_CSP
      : rendererDevOrigin && safeOrigin(details.url) === rendererDevOrigin
        ? rendererDevCsp
        : null;
    if (!csp) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    defaultSession.setPermissionCheckHandler(() => false);
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function openExternalUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url).catch(() => undefined);
  return true;
}

function isAppDocumentUrl(url: string, rendererDevUrl: string | null): boolean {
  if (url.startsWith('file:')) return true;
  const rendererDevOrigin = rendererDevUrl ? safeOrigin(rendererDevUrl) : null;
  return rendererDevOrigin !== null && safeOrigin(url) === rendererDevOrigin;
}
