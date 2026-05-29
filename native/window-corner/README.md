# window_corner — macOS custom window corner radius

A minimal Node-API native addon that gives the Electron `BrowserWindow` a custom
corner radius (24pt, concentric with the floating rails) while keeping the
**standard** window: traffic-light buttons, the system drop shadow, and live
resize all survive.

## Why this exists

Electron exposes only `roundedCorners: true | false` — the OS default is ~10pt on
recent macOS, with no API to set the radius. The pure-web alternative
(`transparent: true` + CSS `border-radius`) works for the corner but on macOS
switches the window into frameless behaviour, which **removes the traffic-light
buttons and the OS shadow**.

So instead of going through Electron's `transparent` flag, this addon reaches the
underlying `NSWindow` directly and sets:

- `contentView.layer.cornerRadius` + `masksToBounds` → the visible 24pt corner
  (with `cornerCurve = continuous` for the macOS squircle shape)
- `window.opaque = NO` + a clear `backgroundColor` → the area outside the rounded
  content is transparent, so the system shadow follows the rounded shape instead
  of the square frame
- `[window invalidateShadow]` → recompute the shadow immediately

Because we never touch Electron's `transparent` flag, the window keeps its title
bar buttons. `main.ts` also sets `roundedCorners: false` on macOS so the OS's own
~10pt rounding does not fight the 24pt layer corner.

See `src/main/nativeWindowCorner.ts` for the loader (which degrades to a silent
no-op when the addon is missing) and `src/core/chromeGeometry.ts` for the radius
constant.

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
