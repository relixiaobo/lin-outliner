import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/main.ts'),
  'utf8',
);

const RESOURCE_PREVIEW_HOST_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/hostPlatform/resourcePreviewHost.ts'),
  'utf8',
);

const WINDOW_APPLICATION_HOST_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/hostPlatform/windowApplicationHost.ts'),
  'utf8',
);

const PREVIEW_RENDERERS_SRC = readFileSync(
  join(import.meta.dir, '../../src/renderer/ui/preview/previewRenderers.tsx'),
  'utf8',
);

const URL_PREVIEW_SESSION_CORE_SRC = readFileSync(
  join(import.meta.dir, '../../src/core/urlPreviewSession.ts'),
  'utf8',
);

const URL_PREVIEW_SESSION_MAIN_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/urlPreviewSession.ts'),
  'utf8',
);

const TRANSLATION_GUEST_SRC = readFileSync(
  join(import.meta.dir, '../../src/renderer/ui/preview/urlPageTranslationGuest.ts'),
  'utf8',
);

const PAGE_TRANSLATION_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/pageTranslation.ts'),
  'utf8',
);

const TRANSLATION_GUEST_HOST_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/urlPageTranslationGuest.ts'),
  'utf8',
);

describe('URL preview webview security posture', () => {
  test('the main window enables webview only behind attach-time hardening', () => {
    expect(WINDOW_APPLICATION_HOST_SRC).toContain('webviewTag: true');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain("contents.on('will-attach-webview'");
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain("contents.on('did-attach-webview'");
  });

  test('webview attach strips preload and keeps remote content sandboxed', () => {
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('delete webPreferences.preload');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.contextIsolation = true');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.nodeIntegration = false');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.nodeIntegrationInSubFrames = false');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.nodeIntegrationInWorker = false');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.partition = URL_PREVIEW_WEBVIEW_PARTITION');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.sandbox = true');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.webSecurity = true');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.allowRunningInsecureContent = false');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.disableDialogs = true');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webPreferences.navigateOnDragDrop = false');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('delete params.preload');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('delete params.webpreferences');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('delete params.httpreferrer');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('httpReferrerForUrlPreview(normalizedSrc)');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('params.httpreferrer = trustedHttpReferrer');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('normalizePreviewHttpUrl(src)');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('normalizePreviewHttpUrl(url)');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('params.partition = URL_PREVIEW_WEBVIEW_PARTITION');
    expect(RESOURCE_PREVIEW_HOST_SRC).not.toContain('params.partition !== URL_PREVIEW_WEBVIEW_PARTITION');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webContents.session !== previewSession()');
    expect(MAIN_SRC).toContain('owner.add(resourcePreviewHost.configurePreviewSession())');
    expect(URL_PREVIEW_SESSION_CORE_SRC).toContain("'persist:url-preview'");
    expect(URL_PREVIEW_SESSION_MAIN_SRC).toContain('previewSession.setPermissionRequestHandler');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).toContain('previewSession.setPermissionCheckHandler');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).toContain('isRendererPermissionAllowed(permission)');
  });

  test('quit teardown keeps live sessions fail-closed until process exit', () => {
    expect(RESOURCE_PREVIEW_HOST_SRC)
      .toContain('defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('defaultSession.setPermissionCheckHandler(() => false)');
    expect(RESOURCE_PREVIEW_HOST_SRC).not.toContain('defaultSession.setPermissionRequestHandler(null)');
    expect(RESOURCE_PREVIEW_HOST_SRC).not.toContain('defaultSession.setPermissionCheckHandler(null)');
    expect(RESOURCE_PREVIEW_HOST_SRC).not.toContain('defaultSession.webRequest.onHeadersReceived(null)');
    expect(URL_PREVIEW_SESSION_MAIN_SRC)
      .toContain('previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).toContain('previewSession.setPermissionCheckHandler(() => false)');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).not.toContain('setPermissionRequestHandler(null)');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).not.toContain('setPermissionCheckHandler(null)');
  });

  test('the renderer URL preview does not request privileged webview features', () => {
    const webview = PREVIEW_RENDERERS_SRC.match(/<webview[\s\S]*?\/>/)?.[0] ?? '';
    expect(webview).toContain('<webview');
    expect(PREVIEW_RENDERERS_SRC).toContain("from '../../../core/urlPreviewSession'");
    expect(webview).toContain('partition={URL_PREVIEW_WEBVIEW_PARTITION}');
    expect(webview).toContain('httpreferrer={httpReferrerForUrlPreview(previewUrl)}');
    expect(PREVIEW_RENDERERS_SRC).not.toContain("addEventListener('did-stop-loading'");
    expect(PREVIEW_RENDERERS_SRC).not.toContain('file-preview-url-loading');
    expect(webview).not.toContain('preload=');
    expect(webview).not.toContain('nodeintegration');
    expect(webview).not.toContain('disablewebsecurity');
    expect(webview).toContain('allowpopups');
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('webContents.setWindowOpenHandler(createUrlPreviewWindowOpenHandler');
    expect(URL_PREVIEW_SESSION_MAIN_SRC).toContain("return { action: 'deny' }");
    expect(URL_PREVIEW_SESSION_MAIN_SRC).not.toContain("action: 'allow'");
  });

  test('translation keeps the guest unprivileged and inserts only inert text', () => {
    expect(TRANSLATION_GUEST_SRC).toContain("'input', 'textarea', 'select', 'option', 'button', 'form', 'nav'");
    expect(TRANSLATION_GUEST_SRC).toContain("'[contenteditable]'");
    expect(TRANSLATION_GUEST_SRC).toContain('translation.textContent = item.translation');
    expect(TRANSLATION_GUEST_SRC).not.toContain('translation.innerHTML');
    expect(TRANSLATION_GUEST_SRC).not.toContain('ipcRenderer');
    expect(TRANSLATION_GUEST_SRC).not.toContain('preload');
    expect(TRANSLATION_GUEST_SRC).not.toContain('webview.executeJavaScript(');
    expect(TRANSLATION_GUEST_HOST_SRC).toContain('executeJavaScriptInIsolatedWorld');
    expect(TRANSLATION_GUEST_HOST_SRC).toContain("guest.hostWebContents !== sender");
    expect(TRANSLATION_GUEST_HOST_SRC).toContain("guest.getType() !== 'webview'");
  });

  test('the scoped translation shortcut is intercepted by the hardened guest host', () => {
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain("webContents.on('before-input-event'");
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain("input.code === 'KeyA'");
    expect(RESOURCE_PREVIEW_HOST_SRC).toContain('LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL');
    expect(RESOURCE_PREVIEW_HOST_SRC)
      .toContain('contents.send(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, webContents.id)');
  });

  test('translation validates bounded blocks and exact response ids in main', () => {
    expect(PAGE_TRANSLATION_SRC).toContain('URL_PAGE_TRANSLATION_MAX_BLOCKS');
    expect(PAGE_TRANSLATION_SRC).toContain('URL_PAGE_TRANSLATION_MAX_BATCH_CHARS');
    expect(PAGE_TRANSLATION_SRC).toContain('requestedIds.has(id)');
    expect(PAGE_TRANSLATION_SRC).toContain('translations.has(id)');
    expect(MAIN_SRC).toContain('!windowApplicationHost.isMainSender(event)');
  });
});
