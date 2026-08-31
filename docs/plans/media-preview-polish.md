# Media Preview Polish

## Goal

Make Source preview chrome recede until it is needed, and give direct audio and
video previews one coherent control language. Video keeps its pixels as the
primary surface with a transparent bottom HUD; audio uses the same control
geometry inside its content surface.

This plan is one complete feature in one PR.

## Non-goals

- Do not change Source identity, preview resolution, media loading, or Core
  commands.
- Do not add artwork, waveform synthesis, chapter data, skip controls, captions,
  or other metadata that the Source does not provide.
- Do not restyle YouTube or webpage-owned players.
- Do not copy the reference palette; functional media state remains neutral and
  tokenized.

## Design

### Source preview actions

The shared Outline `More + Close` group keeps its stable upper-right geometry
but is visually hidden at rest. Hovering anywhere over the preview content,
moving keyboard focus into the group, or opening its menu reveals both controls.
The group remains present in layout and in the tab order, so reveal never causes
reflow and keyboard traversal can discover it. Pointer devices without hover
keep the group visible. Reduced motion removes the opacity transition.

### Shared media HUD

Audio and video retain Media Chrome as the playback authority and share one HUD
structure: a top title row aligned with an exclusive `More + Close` region, a
full-width timeline, then a balanced command row with mute/volume on the left,
play centered, and current/duration time on the right followed by video-only
fullscreen and Source actions. Control sizes, spacing, range geometry, focus
treatment, and responsive compaction are identical. Volume remains a compact
control beside mute instead of stretching across the left grid track; narrow
Outline previews hide only that slider while keeping mute available. Title,
timeline, and command row use distinct vertical tiers, with larger outer insets
than the compact gaps within each control group. Audio ends its time group at the
visible timeline endpoint instead of reserving unavailable fullscreen chrome;
video adds its real fullscreen control before the shared outer inset. The title
information row shares the corner-action top edge and center line. Audio maps
title, time, player icons, and corner actions to primary theme text; video maps
the same elements to the fixed HUD foreground required over pixels.

The audio HUD is the complete compact audio surface. The video HUD overlays the
bottom of the video without an inset card, border, or independent rounded
container. It may use a tokenized pixel-contrast scrim that reads as part of the
video surface and has an opaque reduced-transparency fallback.

Media Chrome is the sole owner of playback state, keyboard shortcuts, and
auto-hide. React does not mirror playback state, install a second keyboard
listener, or subscribe to time updates or pointer movement. Fullscreen removes
the inline preview's maximum dimensions so the video and HUD fill the viewport.

### Accessibility and stability

Keyboard focus always reveals the relevant controls and preserves the shared
neutral focus ring. Touch/coarse-pointer users never depend on hover. Hidden
chrome cannot intercept pointer input, an open action menu keeps its trigger
visible, and no hover state changes player or outliner geometry. Existing media
shortcuts produce one action per keypress. Fullscreen preserves the video aspect
ratio while using the complete viewport.

### Verification

Renderer tests cover the shared HUD structure, its single playback control,
video-only fullscreen, and the absence of duplicate native controls. CSS guards cover stable
source-action geometry, hover/focus/open/touch reveal, transparent video HUD,
shared audio/video control geometry, and accessibility preference fallbacks.
Playwright verifies rest/hover/menu-open Source action visibility plus audio and
video HUD geometry. Visual verification covers light and dark appearances at
desktop and narrow pane widths.

## Open questions

None.

## Expected files

- `src/renderer/ui/preview/previewRenderers.tsx`
- `src/renderer/styles/file-preview.css`
- `docs/spec/design-system/components.md`
- `docs/spec/ui-behavior.md`
- `tests/renderer/filePreviewShell.test.tsx`
- `tests/renderer/inputModalityCss.test.ts`
- `tests/e2e/file-attachments.spec.ts`

## Risks

- Media Chrome exposes some state through custom-element attributes and CSS
  variables; the implementation must use its supported controller behavior
  rather than mirror playback state in React.
- Overlay contrast must remain readable over arbitrary video pixels without
  becoming a second decorative card.
- Hover-only chrome can strand keyboard or touch users unless every reveal path
  is independently covered.
