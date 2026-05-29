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

**macOS 26 "Tahoe" drives the window frame + shadow corner from the private
*radius* selectors, not from `_cornerMask`.** An Electron window's Tahoe default
is `16pt` — smaller than Finder/Raycast — which is why the window looked under-
rounded. Electron removed its own `_cornerMask` override in
electron/electron#48376, and on Tahoe that selector is ignored for frame/shadow
shaping (verified on-device: overriding it returned the right mask yet the frame
kept its default corner). So we set the radius the way
[CornerFix](https://github.com/makalin/CornerFix) reshapes Tahoe windows:

1. **Swizzle the radius getters** (`_cornerRadius`, `_effectiveCornerRadius`,
   `_topCornerRadius`, `_bottomCornerRadius`) to return our per-window radius.
   The system reads these on every relayout, so the value persists (unlike the
   `_cornerMask` field, which the system re-queried and reverted to default after
   startup). We can't recompile Electron, so the swizzle is injected at runtime
   on the live window's *real* dispatch class (`object_getClass`, i.e. the KVO
   `NSKVONotifying_*` subclass), with the radius stored per-window as an
   associated object so other windows keep the OS default.
2. **Call the setters** (`_setCornerRadius:`, `_setEffectiveCornerRadius:`) once
   so any cached backing field updates immediately.
3. **`NSVisualEffectView.maskImage`** — round the vibrancy frost with a resizable
   rounded-rect mask (public API; preserves behind-window blending, unlike an
   ancestor `masksToBounds`). A **`_cornerMask` override** is also kept, as the
   corner mechanism for macOS < 26 where that path is still honored.

The window stays standard (`titleBarStyle: 'hiddenInset'`, never `transparent`),
so native traffic lights, the OS shadow, and vibrancy are all preserved.

**No GPU regression:** this uses Apple's own corner + *default* shadow path. The
reason #48376 dropped `_cornerMask` was that it forced the shadow to render from a
transparent surface (persistent WindowServer GPU load); setting the native radius
does not, so that cost is not reintroduced.

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
