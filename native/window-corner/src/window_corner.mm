// Minimal macOS native addon: give an Electron BrowserWindow a custom corner
// radius (24pt) while keeping the STANDARD window — native traffic lights, the
// OS drop shadow, vibrancy, and live resize all survive.
//
// Mechanism (this is exactly what Electron itself used to do in
// ElectronNSWindow before it was removed for Tahoe — electron/electron#48376):
//
//   1. vibrantView.maskImage = <resizable rounded-rect>  → the vibrancy frost is
//      clipped to the rounded shape (public API; preserves behind-window
//      blending, unlike masksToBounds on an ancestor layer which kills it).
//   2. Override the private `-[NSWindow _cornerMask]` to return the same rounded
//      image. WindowServer uses _cornerMask to shape BOTH the window clip AND
//      its shadow, so this is what makes the *shadow* follow the custom radius —
//      the part a CALayer cornerRadius / maskImage alone cannot do.
//
// We can't recompile Electron, so instead of subclassing we inject (2) at
// runtime by replacing `_cornerMask` on the live window's class and storing the
// per-window mask as an associated object.
//
// TRADE-OFF (the reason Electron dropped this on macOS 15/26 Tahoe): the custom
// _cornerMask forces the window shadow to render from a fully transparent
// surface, which the compositor treats as dynamic → persistent WindowServer GPU
// load. This addon is the experiment to measure whether that cost is acceptable.
//
// Compiled with plain Node-API C headers (no npm dependency) and without ARC
// (nothing is allocated that needs manual release; the mask image is autoreleased
// and retained by the associated object / the view).

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <node_api.h>

// Per-window storage for the active corner mask (read back by the swizzled
// _cornerMask). nil ⇒ fall back to the OS default corner.
static const void* kCornerMaskKey = &kCornerMaskKey;
// Original -[NSWindow _cornerMask] implementation, used as the fallback.
static IMP g_originalCornerMask = NULL;

// Build a resizable rounded-rectangle image whose alpha is the mask: opaque
// inside the rounded rect, transparent in the corners. capInsets keep the
// corners crisp while the centre stretches to any window size.
//
// Drawn with bezierPathWithRoundedRect — a circular arc. (CALayer
// renderInContext with cornerCurve = continuous rendered the corner smaller than
// the requested radius, so it is not used.) The shape is therefore a circular
// arc, not Apple's continuous squircle; the radius is tuned so the visible size
// matches the reference window.
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

// Round every NSVisualEffectView in the subtree via its maskImage (preserves
// behind-window vibrancy blending — masksToBounds on an ancestor would not).
static void RoundEffectViews(NSView* view, NSImage* mask) {
  if ([view isKindOfClass:[NSVisualEffectView class]]) {
    [(NSVisualEffectView*)view setMaskImage:mask];
  }
  for (NSView* sub in [view subviews]) {
    RoundEffectViews(sub, mask);
  }
}

// Replacement for -[NSWindow _cornerMask]: return this window's stored mask if
// one is set, else defer to the original OS implementation.
static NSImage* lin_cornerMask(id self, SEL _cmd) {
  NSImage* mask = objc_getAssociatedObject(self, kCornerMaskKey);
  if (mask != nil) {
    return mask;
  }
  if (g_originalCornerMask != NULL) {
    return ((NSImage* (*)(id, SEL))g_originalCornerMask)(self, _cmd);
  }
  return nil;
}

// Install the _cornerMask override on the window's class exactly once. The mask
// itself is per-window (associated object), so other windows of the same class
// without a mask keep the OS default.
static void InstallCornerMaskOverride(Class cls) {
  static BOOL installed = NO;
  if (installed) {
    return;
  }
  SEL sel = @selector(_cornerMask);
  Method base = class_getInstanceMethod([NSWindow class], sel);
  if (base != NULL) {
    g_originalCornerMask = method_getImplementation(base);
  }
  class_replaceMethod(cls, sel, (IMP)lin_cornerMask, "@@:");
  installed = YES;
}

// setWindowCornerRadius(handle: Buffer, radius?: number) -> boolean
//
// `handle` is BrowserWindow.getNativeWindowHandle(): on macOS its bytes are the
// NSView* of the window's content view container. radius 0 restores the OS
// default corner (e.g. entering fullscreen).
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
      NSImage* mask = radius > 0 ? RoundedMaskImage(radius) : nil;
      // (1) clip the vibrancy frost to the rounded shape.
      RoundEffectViews([window contentView], mask);
      // (2) make WindowServer shape the window + shadow with the same mask.
      InstallCornerMaskOverride([window class]);
      objc_setAssociatedObject(window, kCornerMaskKey, mask, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
