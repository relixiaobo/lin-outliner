// The preload must stay ONE self-contained bundle.
//
// This guard exists because a split preload broke the entire app and no test
// could see it: two rollup entries emit a shared chunk that both bundles
// `require`, and a sandboxed preload's `require` is a polyfill limited to
// electron/events/timers/url. `window.lin` was undefined in every window — no
// document, no IPC, no agent — while `typecheck`, `test:core`, `test:renderer`
// and the whole Playwright suite stayed green, because the renderer specs drive
// the vite dev server in a browser and never load an Electron preload.
//
// So the guard is on the CONFIG (which always exists) and, when a build is
// present, on the emitted bundle.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const CONFIG = join(ROOT, 'electron.vite.config.ts');
const PRELOAD_OUT = join(ROOT, 'out', 'preload');

/** What a sandboxed preload's `require` polyfill can actually resolve. */
const SANDBOX_SAFE_MODULES = new Set(['electron', 'events', 'timers', 'timers/promises', 'url']);

describe('the preload bundle', () => {
  test('declares exactly ONE rollup entry', () => {
    const config = readFileSync(CONFIG, 'utf8');
    const preloadSection = config.slice(config.indexOf('preload:'), config.indexOf('renderer:'));
    // A single string input. An object/array of inputs is what produces the
    // shared chunk; if a second window ever needs its own bridge, branch on a
    // role flag inside the one entry rather than adding a second one.
    expect(preloadSection).toContain("input: 'src/preload/index.ts'");
    expect(preloadSection).not.toMatch(/input:\s*[[{]/);
  });

  test('a built preload requires only sandbox-safe modules', () => {
    if (!existsSync(PRELOAD_OUT)) return; // no build in this run
    const files = readdirSync(PRELOAD_OUT).filter((name) => name.endsWith('.cjs'));
    expect(files).toEqual(['index.cjs']);
    // No chunks directory: a relative `require` is precisely what fails.
    expect(readdirSync(PRELOAD_OUT)).not.toContain('chunks');
    const bundle = readFileSync(join(PRELOAD_OUT, 'index.cjs'), 'utf8');
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]!);
    for (const specifier of required) {
      expect(SANDBOX_SAFE_MODULES.has(specifier)).toBe(true);
    }
  });
});
