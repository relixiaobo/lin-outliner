import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Shared loader for optional macOS native addons (the `window_corner` and
// `browser_tab` .node files). Both have identical packaged-vs-dev path resolution,
// existence-check, `createRequire` load, and shape validation — extracted here so
// packaging/path changes are made once.
//
// `electron` is resolved lazily (not a top-level import) so this module's graph
// stays Electron-free: the unit-tested capture orchestrator transitively imports
// it, and bun's test runtime cannot load the `electron` shim's named exports.

function appIsPackaged(): boolean {
  try {
    const electron = createRequire(import.meta.url)('electron') as typeof import('electron');
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}

/**
 * Load an optional macOS native addon by filename, or null when unavailable.
 * Everything degrades to null — off-darwin, addon unbuilt, load failure, or a
 * shape mismatch (`validate` rejects) — so callers must treat a missing addon as
 * a silent no-op. Caching is the caller's responsibility (each loader memoizes its
 * own result), since the validated type differs per addon.
 *
 * Packaged: electron-builder copies the .node into `Resources/native/<fileName>`.
 * Dev/build-from-source: `__dirname` is `<repo>/out/main`, so the compiled addon
 * sits two levels up under `native/<devSubdir>/build/Release/<fileName>`.
 */
export function loadOptionalMacAddon<T>(args: {
  fileName: string;
  devSubdir: string;
  validate: (mod: unknown) => mod is T;
}): T | null {
  if (process.platform !== 'darwin') return null;
  try {
    const candidates = appIsPackaged()
      ? [join(process.resourcesPath, 'native', args.fileName)]
      : [join(__dirname, `../../native/${args.devSubdir}/build/Release/${args.fileName}`)];
    const found = candidates.find((path) => existsSync(path));
    if (!found) return null;
    const mod = createRequire(import.meta.url)(found) as unknown;
    return args.validate(mod) ? mod : null;
  } catch {
    return null;
  }
}
