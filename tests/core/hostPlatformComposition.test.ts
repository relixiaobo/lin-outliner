import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readMainSource = (path: string): string => readFileSync(
  join(import.meta.dir, '../../src/main', path),
  'utf8',
);

const MAIN_SRC = readMainSource('main.ts');
const RESOURCE_HOST_SRC = readMainSource('hostPlatform/resourcePreviewHost.ts');
const LOCAL_FILE_HOST_SRC = readMainSource('hostPlatform/nativeLocalFileHost.ts');
const LOCAL_FILE_PROCESS_TRACKER_SRC = readMainSource('hostPlatform/localFileProcessTracker.ts');
const WINDOW_HOST_SRC = readMainSource('hostPlatform/windowApplicationHost.ts');

describe('Host platform composition', () => {
  test('main composes platform hosts without constructing their concrete services', () => {
    expect(MAIN_SRC).toContain('createResourcePreviewHost({');
    expect(MAIN_SRC).toContain('createWindowApplicationHost({');
    expect(MAIN_SRC).not.toContain('new BrowserWindow(');
    expect(MAIN_SRC).not.toContain('new AppUpdateStore(');
    expect(MAIN_SRC).not.toContain('new AppUpdateService(');
    expect(MAIN_SRC).not.toContain('new ActionInvocationService(');
    expect(MAIN_SRC).not.toContain('new PreviewTranslationCacheStore(');
    expect(MAIN_SRC).not.toContain('new PageTranslationService(');
    expect(MAIN_SRC).not.toContain('new LocalFilePreviewStreamRegistry(');
    expect(MAIN_SRC).not.toContain('new LinkedFileGrantStore(');
  });

  test('resource preview host owns services, local-file state, sessions, and cleanup', () => {
    expect(RESOURCE_HOST_SRC).toContain('new PreviewTranslationCacheStore(');
    expect(RESOURCE_HOST_SRC).toContain('new PageTranslationService({');
    expect(RESOURCE_HOST_SRC).toContain('new LocalFilePreviewStreamRegistry(options.previewRoots)');
    expect(RESOURCE_HOST_SRC).toContain('new LinkedFileGrantStore(');
    expect(RESOURCE_HOST_SRC).toContain('createNativeLocalFileHost({');
    expect(RESOURCE_HOST_SRC).toContain('configureUrlPreviewSession(previewSession)');
    expect(RESOURCE_HOST_SRC).toContain('configureDefaultSessionSecurity(');
    expect(RESOURCE_HOST_SRC).toContain('localFiles.close(),');
    expect(RESOURCE_HOST_SRC).toContain('streams.close()');
    expect(RESOURCE_HOST_SRC).toContain('if (closePromise) return closePromise;');
    expect(RESOURCE_HOST_SRC).toContain('closePromise = Promise.all([');
    expect(LOCAL_FILE_HOST_SRC).toContain('searchLocalFilePaths(query, limit * 6, processTracker.spawn)');
    expect(LOCAL_FILE_HOST_SRC).toContain('recentLocalFilePaths(limit * 12, processTracker.spawn)');
    expect(LOCAL_FILE_HOST_SRC).toContain('closePromise = processTracker.close();');
    expect(LOCAL_FILE_HOST_SRC).toContain('if (closePromise) return closePromise;');
    expect(LOCAL_FILE_PROCESS_TRACKER_SRC).toContain('activeProcesses = new Map<ChildProcess, Promise<void>>()');
    expect(LOCAL_FILE_PROCESS_TRACKER_SRC).toContain('if (closePromise) return closePromise;');
    expect(LOCAL_FILE_PROCESS_TRACKER_SRC).toContain('child.unref();');

    for (const owner of [
      'searchCache',
      'iconCache',
      'thumbnailCache',
      'pendingIconLoads',
      'pendingThumbnailLoads',
      'lastPickerDirectory',
    ]) {
      expect(LOCAL_FILE_HOST_SRC).toContain(owner);
      expect(MAIN_SRC).not.toContain(owner);
    }
    expect(MAIN_SRC).not.toContain('resolveLocalFileOperation');
  });

  test('window application host owns window, update, action, menu, and launcher effects', () => {
    expect(WINDOW_HOST_SRC.match(/new BrowserWindow\(/g)).toHaveLength(3);
    expect(WINDOW_HOST_SRC).toContain('new AppUpdateStore(');
    expect(WINDOW_HOST_SRC).toContain('new AppUpdateService({');
    expect(WINDOW_HOST_SRC).toContain('new ActionInvocationService({');
    expect(WINDOW_HOST_SRC).toContain('pendingAmbientSeeds = new Map');
    expect(WINDOW_HOST_SRC).toContain('pendingActionStepAcks = new Map');
    expect(WINDOW_HOST_SRC).toContain('registerLauncherHotkey(');
    expect(WINDOW_HOST_SRC).toContain('Menu.setApplicationMenu(buildApplicationMenu())');
    expect(WINDOW_HOST_SRC).toContain("app.on('activate', handleActivate)");
    expect(WINDOW_HOST_SRC).toContain("app.removeListener('activate', handleActivate)");
  });

  test('window application release is idempotent and settles owned effects', () => {
    expect(WINDOW_HOST_SRC).toContain('if (released) return;');
    expect(WINDOW_HOST_SRC).toContain('unregisterLauncherHotkeys();');
    expect(WINDOW_HOST_SRC).toContain('pendingAmbientSeeds.clear();');
    expect(WINDOW_HOST_SRC).toContain('pendingActionStepAcks.clear();');
    expect(WINDOW_HOST_SRC).toContain('actionInvocationService.releaseOpening(launcherInvocationRef);');
    expect(MAIN_SRC).toContain('windowApplicationHost.release();');
  });

  test('window destruction uses the captured renderer identity', () => {
    expect(WINDOW_HOST_SRC).toContain('const rendererId = target.webContents.id;');
    expect(WINDOW_HOST_SRC).toContain('options.releaseOutlineRenderer(rendererId)');
    expect(WINDOW_HOST_SRC).toContain('actionInvocationService.invalidateRenderer(rendererId)');
    expect(WINDOW_HOST_SRC).not.toContain("target.on('closed', () => {\n      options.disposeTranslation();\n      actionInvocationService.invalidateRenderer(target.webContents.id)");
  });
});
