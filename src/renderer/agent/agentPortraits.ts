/// <reference types="vite/client" />
/**
 * Portraits for the bundled roster, under
 * `src/renderer/assets/agent-avatars/<key>.png` (see the README there for what
 * a replacement has to satisfy).
 *
 * Resolved to asset URLs rather than inlined: these are painted illustrations,
 * so there is no markup to style and nothing to inherit `currentColor` — an
 * `<img>` is what they are. One file per identity, sized for the largest place
 * it appears and scaled down by the browser.
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
  portraitSources = import.meta.glob('../assets/agent-avatars/*.png', {
    eager: true,
    import: 'default',
  }) as Record<string, string>;
} catch {
  portraitSources = {};
}

const PORTRAIT_BY_KEY = new Map<string, string>();
for (const [path, raw] of Object.entries(portraitSources)) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  PORTRAIT_BY_KEY.set(file.replace(/\.png$/, ''), raw);
}

/** A bundled portrait's URL, or `undefined` when nothing is vendored for it. */
export function agentPortraitUrl(avatarKey: string | null): string | undefined {
  return avatarKey === null ? undefined : PORTRAIT_BY_KEY.get(avatarKey);
}
