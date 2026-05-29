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

// setWindowCornerRadius(handle: Buffer, radius?: number) -> boolean
//
// `handle` is BrowserWindow.getNativeWindowHandle(): on macOS its bytes are the
// NSView* of the window's content view container.
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
      NSView* content = [window contentView];
      [content setWantsLayer:YES];
      CALayer* layer = [content layer];
      if (layer != nil) {
        [layer setCornerRadius:radius];
        [layer setMasksToBounds:YES];
        // Continuous (squircle) curve matches the macOS window-corner shape
        // rather than a circular arc. Available since macOS 10.15.
        if (@available(macOS 10.15, *)) {
          layer.cornerCurve = kCACornerCurveContinuous;
        }
      }
      // Do NOT touch window.opaque / backgroundColor here. A vibrancy window is
      // already non-opaque with its NSVisualEffectView backing; forcing
      // opaque=NO + clearColor strips that frost and makes the whole deck show
      // the raw desktop. Clipping the content layer above already makes the
      // corners transparent, so the system shadow follows the rounded shape
      // once we invalidate it.
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
