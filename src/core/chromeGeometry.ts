export const MAC_TRAFFIC_LIGHT_SIZE = 12;

export const MAC_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 15,
} as const;

// Custom window corner radius (points). Concentric with the floating rails:
// window 24 → rail/panel 16 → composer 8. Applied natively on macOS via the
// window_corner addon (src/main/nativeWindowCorner.ts); the OS default is ~10pt.
export const MAC_WINDOW_CORNER_RADIUS = 24;
