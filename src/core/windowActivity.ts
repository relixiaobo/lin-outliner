// The main process forwards the main window's native focus/blur to the renderer
// so the chrome can desaturate while the window is inactive — the macOS
// convention where an unfocused window's toolbars/sidebars lose their tint. This
// is a UI-state signal, not a document mutation, so it lives in its own tiny
// module rather than the protocol surface in core/types.ts (a coordination file).
//
// Payload is a single boolean: `true` while the window holds OS focus.
export const LIN_WINDOW_ACTIVE_CHANNEL = 'lin:window-active';
