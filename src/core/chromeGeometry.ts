export const MAC_TRAFFIC_LIGHT_SIZE = 12;

export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 15,
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
