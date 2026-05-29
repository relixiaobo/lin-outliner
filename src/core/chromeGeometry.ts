export const MAC_TRAFFIC_LIGHT_SIZE = 12;

export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 15,
} as const;

// Custom window corner radius (points), applied natively on macOS via the
// window_corner addon (src/main/nativeWindowCorner.ts) which overrides the
// window's _cornerMask. Circular-arc mask tuned so the visible corner matches
// Raycast's window (a circular arc reads a touch tighter than Raycast's
// continuous curve, so the radius runs a bit larger). Adjust to taste; this
// single value drives the corner + shadow.
export const MAC_WINDOW_CORNER_RADIUS = 28;
