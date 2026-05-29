// Minimal macOS native addon: give an Electron BrowserWindow a custom corner
// radius (24pt) while keeping the standard window — traffic lights, the system
// drop shadow, and live resize all survive.
//
// Why a native addon at all: Electron exposes only `roundedCorners: true|false`
// (the OS default is ~10pt on recent macOS) and has no API to set the radius.
// Going through Electron's `transparent: true` path *does* let CSS round the
// corners, but on macOS that switches the window into frameless behaviour and
// removes the traffic-light buttons + the OS shadow. So instead we leave the
// window standard and reach the underlying NSWindow directly:
//
//   * contentView.layer.cornerRadius + masksToBounds  → the visible 24pt corner
//   * window.opaque = NO + clearColor backing         → the corners outside the
//                                                        rounded content are
//                                                        transparent, so the OS
//                                                        shadow follows the
//                                                        rounded shape, not the
//                                                        square frame
//   * [window invalidateShadow]                        → recompute the shadow now
//
// The window keeps its title-bar buttons because we never set Electron's
// `transparent` flag — we only mutate NSWindow/CALayer properties.
//
// Compiled with plain Node-API C headers (node_api.h, shipped with the Electron
// headers) so the module pulls in no npm dependency. No ARC — nothing is
// allocated here, so there is nothing to release.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

// Build a resizable rounded-rectangle image whose alpha is used as a view mask:
// opaque inside the rounded rect, transparent in the corners. capInsets keep the
// corners crisp while the centre stretches to any size.
static NSImage* RoundedMaskImage(CGFloat radius) {
  CGFloat side = radius * 2 + 1;
  NSImage* image = [[[NSImage alloc] initWithSize:NSMakeSize(side, side)] autorelease];
  [image lockFocus];
  [[NSColor blackColor] setFill];
  NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(0, 0, side, side)
                                                       xRadius:radius
                                                       yRadius:radius];
  [path fill];
  [image unlockFocus];
  [image setCapInsets:NSEdgeInsetsMake(radius, radius, radius, radius)];
  [image setResizingMode:NSImageResizingModeStretch];
  return image;
}

// Round every NSVisualEffectView in the subtree via its maskImage. Masking the
// effect view this way (rather than clipping an ancestor layer with
// masksToBounds) preserves its behind-window vibrancy blending — masksToBounds
// on an ancestor turns the frost into raw transparency.
static void RoundEffectViews(NSView* view, NSImage* mask) {
  if ([view isKindOfClass:[NSVisualEffectView class]]) {
    [(NSVisualEffectView*)view setMaskImage:mask];
  }
  for (NSView* sub in [view subviews]) {
    RoundEffectViews(sub, mask);
  }
}

// setWindowCornerRadius(handle: Buffer, radius?: number) -> boolean
//
// `handle` is BrowserWindow.getNativeWindowHandle(): on macOS its bytes are the
// NSView* of the window's content view container.
//
// Rounds the OS vibrancy backing (NSVisualEffectView maskImage) and recomputes
// the window shadow so it follows the rounded shape. The web layer's own frost
// is rounded separately in CSS (border-radius on .app under a window material) —
// both layers must round or the corner shows a square edge.
static napi_value SetWindowCornerRadius(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  napi_value result;

  void* handleData = NULL;
  size_t handleLen = 0;
  if (argc < 1 || napi_get_buffer_info(env, args[0], &handleData, &handleLen) != napi_ok ||
      handleData == NULL || handleLen < sizeof(void*)) {
    napi_get_boolean(env, false, &result);
    return result;
  }

  double radius = 24.0;
  if (argc >= 2) {
    double parsed = 0.0;
    if (napi_get_value_double(env, args[1], &parsed) == napi_ok && parsed >= 0.0) {
      radius = parsed;
    }
  }

  NSView* view = *reinterpret_cast<NSView**>(handleData);
  bool ok = false;
  if (view != nil) {
    NSWindow* window = [view window];
    if (window != nil) {
      // radius 0 means "remove the rounding" (e.g. entering fullscreen): a nil
      // maskImage restores the square effect view.
      NSImage* mask = radius > 0 ? RoundedMaskImage(radius) : nil;
      RoundEffectViews([window contentView], mask);
      // Do NOT set masksToBounds on the content view — that clips the vibrancy
      // ancestor and kills behind-window blending (the deck would show the raw
      // desktop). The maskImage above rounds the frost without breaking it.
      [window invalidateShadow];
      ok = true;
    }
  }

  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "setWindowCornerRadius", NAPI_AUTO_LENGTH,
                       SetWindowCornerRadius, NULL, &fn);
  napi_set_named_property(env, exports, "setWindowCornerRadius", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
