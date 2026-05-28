// Window background material is chosen once, from the platform, and consumed in
// two places: the main process (to configure the BrowserWindow) and the preload
// (to tell the renderer which translucent surface treatment to apply). Keeping
// the platform -> material mapping here stops those two sides from drifting.

export type WindowMaterialKind = 'vibrancy' | 'mica' | null;

// macOS gets NSVisualEffectView vibrancy; Windows 11 gets Mica. Everything else
// (Linux, unknown) gets no material and keeps fully opaque surfaces.
export function windowMaterialKind(platform: NodeJS.Platform): WindowMaterialKind {
  if (platform === 'darwin') return 'vibrancy';
  if (platform === 'win32') return 'mica';
  return null;
}
