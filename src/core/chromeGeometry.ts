export const MAC_TRAFFIC_LIGHT_SIZE = 12;

// Traffic-light corner inset. A symmetric corner: x and y are equal, so the
// gap above the lights matches the gap to their left. x aligns the lights' left
// edge with the sidebar nav icons (rail gap 8 + rail-pad 8 + row content-start 8
// = 24) and clears the 24px window corner (MAC_WINDOW_CORNER_RADIUS); y gives the
// same 24px top inset. Keep --traffic-light-x/y in tokens.css in sync with these.
export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 24,
  y: 24,
} as const;

// Custom window corner radius (points), applied natively on macOS via the
// window_corner addon (src/main/nativeWindowCorner.ts). On macOS 26 Tahoe it
// overrides the private _cornerRadius / _effectiveCornerRadius selectors (an
// Electron window's Tahoe default is 16pt, smaller than Finder/Raycast); on
// older macOS it falls back to the _cornerMask override. Uses Apple's own
// corner + default shadow path, so it does not reintroduce the Tahoe
// WindowServer GPU regression of electron/electron#48376. Adjust to taste;
// changing this needs only a restart (no native rebuild).
export const MAC_WINDOW_CORNER_RADIUS = 24;
