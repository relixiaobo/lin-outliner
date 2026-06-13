# macOS Liquid Glass App Icon

## Goal

Ship a **true Liquid Glass** Tenon app icon for macOS 26 (Tahoe) — the layered
`.icon` (Icon Composer) format the OS renders with dynamic glass material,
specular edges and depth — while keeping a legacy `.icns` fallback for macOS < 26.

## Non-goals

- Not part of `macos-native-branding-polish` (that PR keeps the clean flat
  squircle `.icns`, white-frame bug fixed). This is a separate, later pass.
- Faking a static "glass edge" in the flat SVG — rejected; the real effect is
  OS-rendered from the `.icon`, not bakeable into a flat PNG.

## Verified end-to-end (2026-06-03)

The whole pipeline was proven on this machine with a throwaway hand-authored
`.icon`; **none of it is committed** — this section is the recipe.

**Toolchain present & sufficient:** macOS 26.4.1 · Xcode 26.3 · `/usr/bin/actool`
(≥26) · electron-builder **26.8.1** already supports `.icon` via `mac.icon`
(`app-builder-lib/.../macPackager.js:431` + `util/macosIconComposer.js`).

**`.icon` bundle = a directory:**

```
icon.icon/
  icon.json              # manifest
  Assets/<layer>.png     # one transparent PNG per layer (NO squircle — the OS
                         # supplies the shape; the dark background is `fill`)
```

Minimal `icon.json` (schema reverse-engineered from real bundles, e.g.
`ninxsoft/Mist`):

```json
{
  "fill": { "solid": "display-p3:0.11765,0.11765,0.11765,1.00000" },
  "groups": [{
    "layers": [{ "glass": true, "image-name": "glyph.png", "name": "glyph" }],
    "shadow": { "kind": "neutral", "opacity": 0.5 },
    "translucency": { "enabled": true, "value": 0.5 }
  }],
  "supported-platforms": { "squares": ["macOS"] }
}
```

**electron-builder wiring:** set `build.mac.icon` to the `.icon`. It then (1) runs
`actool` → writes `Contents/Resources/Assets.car` + sets `CFBundleIconName=Icon`,
and (2) still bundles a legacy `icon.icns` (`CFBundleIconFile`) for macOS < 26.
Verified packaged `Tenon.app` had BOTH keys + `Assets.car`, and the actool-derived
icns rendered the real glass appearance (specular glyph, depth, system squircle).

actool args electron-builder uses (for reference / manual builds):
`actool <Icon.icon> --compile <out> --app-icon Icon --include-all-app-icons
--accent-color AccentColor --target-device mac --minimum-deployment-target 26.0
--platform macosx --output-partial-info-plist <out>/partial.plist`.

## Open questions / work to do

1. **Author a real `.icon` in Icon Composer** (the GUI, ships with Xcode 26) —
   proper multi-layer design (glyph layer(s) + background), tuned glass on/off,
   fill gradient, and scale. The hand cut used a single `glass:true` glyph layer
   at ~0.81 scale on a flat dark fill — fine as proof, not a final design.
2. **Build-dependency decision.** `mac.icon=.icon` makes **Xcode 26+ (actool) a
   hard requirement** on every machine that builds the `.dmg` — today the build
   needs only node/electron. Accept, or generate `Assets.car` once and commit it +
   wire manually via `afterPack` so routine builds don't need Xcode.
3. **Legacy icns fallback.** actool's derived icns capped at 256px in the trial;
   ship our existing full-ladder `build/icon.icns` as the explicit < 26 fallback
   rather than the derived one.
4. **Dev Dock icon** stays the flat `build/icon.png` (`app.dock.setIcon`) — LG only
   applies to the packaged bundle's `Assets.car`. Acceptable (matches the dev
   "Electron"-name story).
5. **Signing.** We ship unsigned (`identity: null`); the LG icon renders for local
   installs. Revisit if/when signing+notarization is added.

## Key files (when implemented)

- `build/icon.icon/` (new) — Icon Composer source.
- `package.json` `build.mac.icon` → `build/icon.icon`; keep `build/icon.icns`.
- `assets/brand/tenon-icon-master.svg` + `scripts/gen-icon.mjs` — keep producing
  the flat `.icns`/`.png` for the < 26 fallback + dev Dock.
