# window_corner — macOS custom window corner radius

A minimal Node-API native addon that gives the Electron `BrowserWindow` a custom
corner radius while keeping the **standard** window: native traffic-light buttons,
the OS drop shadow, vibrancy, and live resize all survive. The radius is
`MAC_WINDOW_CORNER_RADIUS` in `src/core/chromeGeometry.ts`.

## Why this exists

Electron exposes only `roundedCorners: true | false` (no radius API; the default
is small on recent macOS). The pure-web alternative (`transparent: true` + CSS
`border-radius`) rounds the corner but on macOS switches the window into frameless
behaviour, which **removes the traffic-light buttons and the OS shadow**. And a
plain `contentView.layer.cornerRadius + masksToBounds` clips the
`NSVisualEffectView` ancestor, which **kills behind-window vibrancy** (the deck
shows the raw desktop), and does not round the *window shadow* anyway (that comes
from the window frame, not the content layer).

## How it works

This replicates exactly what Electron itself used to do in `ElectronNSWindow`
before it was removed for Tahoe (electron/electron#48376):

1. **`NSVisualEffectView.maskImage`** — round the vibrancy frost with a resizable
   rounded-rect mask (public API; preserves behind-window blending, unlike an
   ancestor `masksToBounds`).
2. **Override `-[NSWindow _cornerMask]`** to return the same rounded image.
   WindowServer uses `_cornerMask` to shape **both the window clip and its
   shadow**, so this is what rounds the *shadow* at a custom radius. We can't
   recompile Electron, so the override is injected at runtime by replacing
   `_cornerMask` on the live window's class and storing the per-window mask as an
   associated object (other windows of the same class keep the OS default).

The window stays standard (`titleBarStyle: 'hiddenInset'`, never `transparent`),
so native traffic lights, the OS shadow, and vibrancy are all preserved.

**Trade-off (measured, acceptable here):** the custom `_cornerMask` is the reason
Electron dropped this on macOS 15/26 Tahoe — it can raise WindowServer GPU load.
On-device `powermetrics` A/B (corner on vs off) showed no measurable difference in
GPU active residency, so it is kept. Re-measure if that changes.

See `src/main/nativeWindowCorner.ts` for the loader (which degrades to a silent
no-op when the addon is missing / off-darwin / load fails).

## Building

The addon is compiled against the Electron headers, not the system Node headers:

```bash
bun run build:native
```

That runs `node-gyp rebuild` with `--runtime=electron`, the installed Electron
version as `--target`, and the Electron headers dist URL. The output lands at
`native/window-corner/build/Release/window_corner.node` (gitignored). It is
**not** built by `electron-vite dev`, so run `bun run build:native` once before
`bun run dev:*`. `bun run app:build` runs it automatically before packaging.

## Packaging

`package.json`'s `build.extraResources` copies the `.node` into the app bundle's
`Resources/native/` (outside the asar, so it is loadable). The loader resolves
`process.resourcesPath/native/window_corner.node` in a packaged build and the
`build/Release` path when running from source.

## Rebuild on Electron upgrades

The compiled binary is tied to the Electron ABI. After bumping the `electron`
version, re-run `bun run build:native`.

## Platform

macOS only. On other platforms the loader returns a no-op and the window keeps
its default corner.
