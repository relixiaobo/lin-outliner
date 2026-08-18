/// <reference types="vite/client" />
/**
 * Portraits for the bundled roster, vendored under
 * `src/renderer/assets/agent-avatars/<key>.svg` (see the README there for the
 * drawing constraints).
 *
 * Imported as RAW markup rather than as asset URLs so each one inlines into the
 * DOM: an inline `<svg>` is styleable and scales with its container, which is
 * how one file serves both the 24px header disc and the larger one in a pushed
 * view — the same reason `providerIcon.ts` inlines brand logos.
 *
 * Deliberately its own leaf module. `import.meta.glob` is a bundler feature
 * that does not exist outside Vite, so anything importing this cannot be loaded
 * by a plain test runner; keeping it away from identity resolution lets that
 * logic — and the store that holds the catalog — stay ordinary modules.
 */
let portraitSources: Record<string, string> = {};
try {
  // Vite replaces this call with a static object at build time. Outside the
  // bundler — a plain test runner — there is nothing to replace it with, and
  // the call throws; every identity then wears its initial disc, which is the
  // same fallback an unconfigured Role gets. A missing picture must not take a
  // transcript down with it (A12).
  portraitSources = import.meta.glob('../assets/agent-avatars/*.svg', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;
} catch {
  portraitSources = {};
}

const PORTRAIT_BY_KEY = new Map<string, string>();
for (const [path, raw] of Object.entries(portraitSources)) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  PORTRAIT_BY_KEY.set(file.replace(/\.svg$/, ''), raw);
}

/** A bundled portrait's markup, or `undefined` when nothing is vendored for it. */
export function agentPortraitSvg(avatarKey: string | null): string | undefined {
  return avatarKey === null ? undefined : PORTRAIT_BY_KEY.get(avatarKey);
}
