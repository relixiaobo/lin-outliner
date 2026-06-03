// Regenerate the macOS app-icon assets from the single source of truth,
// assets/brand/tenon-icon-master.svg (a 1024 canvas with an 824 squircle on a
// 100px transparent gutter — Apple's macOS icon grid; macOS does not auto-mask).
//
// Produces:
//   build/icon.png   — 1024 PNG; dev Dock icon (app.dock.setIcon) + linux/extra.
//   build/icon.icns  — full 16→1024 ladder for the packaged bundle.
//
// Rasterizes the SVG with headless Chromium (Playwright, already a devDependency)
// and a TRANSPARENT background. macOS `qlmanage` was tried first but mattes the
// transparent gutter to opaque WHITE — which renders as a white frame in the Dock.
// Chromium screenshot with omitBackground keeps the gutter truly transparent.
// The size ladder + .icns packing use macOS `sips` + `iconutil` (macOS-only).
//
// Run after editing the master, then commit both build/ artifacts:
//   node scripts/gen-icon.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = 'assets/brand/tenon-icon-master.svg';
const OUT_PNG = 'build/icon.png';
const OUT_ICNS = 'build/icon.icns';
const SIZE = 1024;

const svg = readFileSync(MASTER, 'utf8');

// 1. Rasterize the SVG master to a transparent 1024 PNG via Chromium.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  const png = await page.screenshot({ omitBackground: true });
  writeFileSync(OUT_PNG, png);
} finally {
  await browser.close();
}

// 2. Build the iconset ladder and pack it into .icns. sips preserves the source
//    alpha when downscaling, so the transparent gutter survives at every size.
const iconset = mkdtempSync(join(tmpdir(), 'tenon-icon-')) + '.iconset';
execFileSync('mkdir', ['-p', iconset]);
try {
  const ladder = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [px, name] of ladder) {
    execFileSync('sips', ['-z', String(px), String(px), OUT_PNG, '--out', join(iconset, name)], {
      stdio: 'ignore',
    });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT_ICNS]);
} finally {
  rmSync(iconset, { recursive: true, force: true });
}

console.log(`gen-icon: wrote ${OUT_PNG} (${SIZE}) + ${OUT_ICNS}`);
