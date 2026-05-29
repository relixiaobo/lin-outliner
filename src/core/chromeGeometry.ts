export const MAC_TRAFFIC_LIGHT_SIZE = 12;

export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 15,
} as const;

// Custom window corner radius (points), applied natively on macOS via the
// window_corner addon (src/main/nativeWindowCorner.ts) which overrides the
// window's _cornerMask. Tuned to match the large macOS Tahoe window corner of
// Finder / Raycast (bigger than the ~10pt pre-Tahoe default). Adjust to taste —
// this single value drives the whole window corner + its shadow.
export const MAC_WINDOW_CORNER_RADIUS = 30;
