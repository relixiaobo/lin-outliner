// Build-time half of the preload guard (tests/core/preloadBundle.test.ts is the
// test-time half). Runs inside `app:build`, right after electron-vite build, so
// a preload that cannot load in a sandboxed window fails the BUILD — not the
// first user who installs it.
//
// v0.3.0 shipped dead because the preload's import graph reached semver (via
// core/appUpdate), electron-vite externalized it into a runtime require(), and
// the sandboxed preload's require polyfill resolves only electron/events/
// timers/url. Config-level guards cannot see that; only the emitted artifact
// can. This script refuses any require() outside the sandbox-safe set and any
// chunk file beside the single entry.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PRELOAD_OUT = join(ROOT, 'out', 'preload');
const SANDBOX_SAFE_MODULES = new Set(['electron', 'events', 'timers', 'timers/promises', 'url']);

if (!existsSync(PRELOAD_OUT)) {
  console.error('check-preload-bundle: out/preload does not exist — run electron-vite build first.');
  process.exit(1);
}

const files = readdirSync(PRELOAD_OUT, { recursive: true, encoding: 'utf8' });
const bundles = files.filter((name) => name.endsWith('.cjs') || name.endsWith('.js') || name.endsWith('.mjs'));
if (bundles.length !== 1 || bundles[0] !== 'index.cjs') {
  console.error(`check-preload-bundle: expected exactly [index.cjs], found: ${JSON.stringify(bundles)}`);
  process.exit(1);
}

const source = readFileSync(join(PRELOAD_OUT, 'index.cjs'), 'utf8');
const offenders = new Set<string>();
for (const match of source.matchAll(/\brequire\(\s*(["'])([^"')]+)\1\s*\)/g)) {
  const specifier = (match[2] ?? '').replace(/^node:/, '');
  if (!SANDBOX_SAFE_MODULES.has(specifier)) offenders.add(specifier);
}

if (offenders.size > 0) {
  console.error(
    'check-preload-bundle: the built preload require()s modules a sandboxed preload cannot resolve:\n'
    + [...offenders].map((name) => `  - ${name}`).join('\n')
    + '\nBundle the dependency or break the import chain (see src/core/appUpdateProtocol.ts for the pattern).',
  );
  process.exit(1);
}

console.log('check-preload-bundle: OK — one bundle, sandbox-safe requires only.');
