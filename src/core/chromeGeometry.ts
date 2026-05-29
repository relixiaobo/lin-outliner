export const MAC_TRAFFIC_LIGHT_SIZE = 12;

export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 15,
} as const;

// Custom window corner radius (points), applied natively on macOS via the
// window_corner addon (src/main/nativeWindowCorner.ts) which overrides the
// window's _cornerMask. The addon renders Apple's continuous (squircle) curve,
// so this matches Raycast's window corner (measured ~20pt) rather than a tighter
// circular arc. Adjust to taste; this single value drives the corner + shadow.
export const MAC_WINDOW_CORNER_RADIUS = 22;
