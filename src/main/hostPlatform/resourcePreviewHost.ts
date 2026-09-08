import { dialog, session, shell, webContents, type BrowserWindow, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { normalizePreviewHttpUrl } from '../../core/preview';
import { ASSET_URL_SCHEME, PREVIEW_LOCAL_URL_SCHEME } from '../../core/assets';
import {
  LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL,
} from '../../core/urlPageTranslation';
import {
  httpReferrerForUrlPreview,
  URL_PREVIEW_WEBVIEW_PARTITION,
} from '../../core/urlPreviewSession';
import type { ErrorReport } from '../../core/errorObservability';
import type { Locale } from '../../core/locale';
import { getMessages } from '../../core/i18n';
import { portableChordMatchesEvent } from '../../core/keybindings';
import { isRendererPermissionAllowed } from '../rendererPermissions';
import {
  clearUrlPreviewSessionData,
  configureUrlPreviewSession,
  createUrlPreviewWindowOpenHandler,
  flushUrlPreviewSession,
} from '../urlPreviewSession';
import { PageTranslationService, pageTranslationErrorReport } from '../pageTranslation';
import { PreviewTranslationCacheStore } from '../previewTranslationCacheStore';
import { PreviewOperations, type PreviewOperationCaller } from '../hostDomain/previewOperations';
import { PREVIEW_ACTION_CHANNEL, type DataOperationView } from '../../core/previewOperations';
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
  readonly operationWindow?: (caller: PreviewOperationCaller) => BrowserWindow | null;
  readonly locale?: () => Locale;
  readonly dataChanged?: () => void;
  readonly userDataDir: string;
  readonly rendererDevUrl?: string;
  readonly previewRoots: () => readonly string[];
  readonly localFileRoots: () => readonly string[];
  readonly translationShortcutBindings: () => readonly string[];
  readonly resolveAttachmentFile: NativeLocalFileHostOptions['resolveAttachmentFile'];
  readonly resolveResourceFile: NativeLocalFileHostOptions['resolveResourceFile'];
  readonly reportError: (report: ErrorReport) => void;
}

export interface ResourcePreviewHost {
  readonly operations: PreviewOperations;
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
  let dataNotificationTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyDataChanged = () => {
    if (dataNotificationTimer) return;
    dataNotificationTimer = setTimeout(() => {
      dataNotificationTimer = null;
      try { options.dataChanged?.(); } catch { /* A closed window cannot fail cache writes. */ }
    }, 100);
    dataNotificationTimer.unref?.();
  };
  const previewTranslationCache = new PreviewTranslationCacheStore(
    join(options.userDataDir, 'preview-translation-cache'),
    {
      onChanged: notifyDataChanged,
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
  const operations = new PreviewOperations({
    cache: previewTranslationCache,
    changed: () => options.dataChanged?.(),
    send: (ownerId, action) => {
      const target = webContents.fromId(ownerId);
      if (!target || target.isDestroyed()) throw new Error('Preview window is unavailable.');
      target.send(PREVIEW_ACTION_CHANNEL, action);
    },
    review: async (scope, caller) => {
      const parent = options.operationWindow?.(caller);
      if (!parent || parent.isDestroyed() || caller.signal?.aborted) return false;
      const labels = getMessages(options.locale?.() ?? 'en').settings.general;
      const website = scope === 'websites';
      const title = website ? labels.websiteDataClearConfirmTitle : labels.translationDataClearConfirmTitle;
      const result = await dialog.showMessageBox(parent, {
        type: 'warning', title,
        message: scope === 'content' ? labels.translationContentClearConfirmMessage
          : website ? labels.websiteDataClearConfirmMessage : labels.translationDataClearConfirmMessage,
        detail: website ? labels.websiteDataClearConfirmDetail : labels.translationDataClearConfirmDetail,
        buttons: [website ? labels.websiteDataClearConfirmAction : labels.translationDataClearConfirmAction, labels.translationDataCancelAction],
        defaultId: 1, cancelId: 1, noLink: true,
        ...(caller.signal ? { signal: caller.signal } : {}),
      });
      return result.response === 0 && !parent.isDestroyed() && !caller.signal?.aborted;
    },
    websites: async () => ({
      available: previewSession !== null,
      cacheBytes: previewSession ? await previewSession.getCacheSize().catch(() => null) : null,
      activeGuests: [...previewGuests].filter((guest) => !guest.isDestroyed()).length,
    }),
    clearWebsites: async () => {
      if (!previewSession) throw new Error('Preview session is unavailable.');
      const steps = await clearUrlPreviewSessionData(previewSession);
      let liveDisplays: DataOperationView['liveDisplays'] = 'retained';
      if (!steps.some((step) => step.state === 'failed')) {
        liveDisplays = 'reload_requested';
        for (const guest of previewGuests) {
          if (guest.isDestroyed()) continue;
          try { guest.reloadIgnoringCache(); } catch { liveDisplays = 'reload_failed'; }
        }
      }
      return { steps, liveDisplays };
    },
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (dataNotificationTimer) clearTimeout(dataNotificationTimer);
    pageTranslation.dispose();
    closePromise = (async () => {
      await operations.settle();
      await Promise.all([
        localFiles.close(),
        previewTranslationCache.flushNow(),
        flushUrlPreviewSession(previewSession),
        streams.close(),
      ]);
    })();
    return closePromise;
  };

  const host: ResourcePreviewHost = {
    operations,
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
    hardenWebContents: (contents) => {
      contents.once('destroyed', () => operations.releaseOwner(contents.id));
      contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) operations.releaseOwner(contents.id);
      });
      hardenWebContents(contents, () => previewSession, previewGuests, options);
    },
    configureDefaultSessionSecurity: () => configureDefaultSessionSecurity(
      rendererDevOrigin,
      rendererDevCsp,
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
        && options.translationShortcutBindings().some((chord) => portableChordMatchesEvent(chord, {
          key: input.key,
          code: input.code,
          ctrlKey: input.control,
          metaKey: input.meta,
          shiftKey: input.shift,
          altKey: input.alt,
        }));
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
