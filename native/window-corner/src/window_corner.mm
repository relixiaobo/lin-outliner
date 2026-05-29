// Minimal macOS native addon: give an Electron BrowserWindow a custom corner
// radius while keeping the STANDARD window — native traffic lights, the OS drop
// shadow, vibrancy, and live resize all survive. The radius is
// MAC_WINDOW_CORNER_RADIUS in src/core/chromeGeometry.ts.
//
// Mechanism (and why it is what it is):
//
//   macOS 26 "Tahoe" drives a window's frame + shadow corner from the private
//   *radius* selectors `_cornerRadius` / `_effectiveCornerRadius` (an Electron
//   window's Tahoe default is 16pt). It does NOT read the older `_cornerMask`
//   image — Electron removed its own `_cornerMask` override in
//   electron/electron#48376, and on Tahoe that selector is simply ignored for
//   frame/shadow shaping (verified on-device: overriding it had no effect).
//
//   So we set the radius the way CornerFix (github.com/makalin/CornerFix) does:
//     1. swizzle the radius getters (`_cornerRadius`, `_effectiveCornerRadius`,
//        `_topCornerRadius`, `_bottomCornerRadius`) to return our per-window
//        radius — this is what the system reads on every relayout, so it
//        persists (unlike the `_cornerMask` field, which the system re-queried
//        and reverted).
//     2. call the setters (`_setCornerRadius:`, `_setEffectiveCornerRadius:`)
//        once so any cached backing field is updated immediately.
//     3. round the vibrancy frost via `NSVisualEffectView.maskImage` (public),
//        and keep a `_cornerMask` override too, as the corner mechanism for
//        macOS < 26 where that path is still honored.
//
//   Because this uses Apple's own corner + default shadow path (not a custom
//   `_cornerMask` that forces the shadow off a transparent surface), it does NOT
//   reintroduce the Tahoe WindowServer GPU regression that #48376 fixed.
//
// Compiled with plain Node-API C headers (no npm dependency) and without ARC.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <node_api.h>

// Per-window desired radius (NSNumber) and frost mask (NSImage), read back by
// the swizzled getters. nil ⇒ fall back to the OS default corner.
static const void* kCornerRadiusKey = &kCornerRadiusKey;
static const void* kCornerMaskKey = &kCornerMaskKey;

// Captured originals (one per selector), used as the per-window fallback so
// other windows of the same class with no radius set keep the OS default.
static IMP g_orig_cornerMask = NULL;
static IMP g_orig_cornerRadius = NULL;
static IMP g_orig_effectiveCornerRadius = NULL;
static IMP g_orig_topCornerRadius = NULL;
static IMP g_orig_bottomCornerRadius = NULL;

typedef CGFloat (*RadiusGetterIMP)(id, SEL);

// ---- frost (NSVisualEffectView.maskImage) --------------------------------

// Resizable rounded-rect mask: opaque inside, transparent corners; capInsets
// keep the corners crisp while the centre stretches to the window size.
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

static void RoundEffectViews(NSView* view, NSImage* mask) {
  if ([view isKindOfClass:[NSVisualEffectView class]]) {
    [(NSVisualEffectView*)view setMaskImage:mask];
  }
  for (NSView* sub in [view subviews]) {
    RoundEffectViews(sub, mask);
  }
}

// ---- swizzled getters ----------------------------------------------------

static NSImage* lin_cornerMask(id self, SEL _cmd) {
  NSImage* mask = objc_getAssociatedObject(self, kCornerMaskKey);
  if (mask != nil) return mask;
  if (g_orig_cornerMask != NULL) {
    return ((NSImage* (*)(id, SEL))g_orig_cornerMask)(self, _cmd);
  }
  return nil;
}

// One replacement for every radius getter: return this window's stored radius,
// else defer to the captured original for that selector.
static CGFloat lin_radius(id self, SEL _cmd) {
  NSNumber* r = objc_getAssociatedObject(self, kCornerRadiusKey);
  if (r != nil) return (CGFloat)[r doubleValue];
  IMP orig = NULL;
  if (sel_isEqual(_cmd, @selector(_cornerRadius))) orig = g_orig_cornerRadius;
  else if (sel_isEqual(_cmd, @selector(_effectiveCornerRadius))) orig = g_orig_effectiveCornerRadius;
  else if (sel_isEqual(_cmd, @selector(_topCornerRadius))) orig = g_orig_topCornerRadius;
  else if (sel_isEqual(_cmd, @selector(_bottomCornerRadius))) orig = g_orig_bottomCornerRadius;
  if (orig != NULL) return ((RadiusGetterIMP)orig)(self, _cmd);
  return 0;
}

// Swizzle one getter on the real dispatch class, capturing the original once.
// No-op when the selector does not exist on this OS version.
static void SwizzleRadiusGetter(Class cls, SEL sel, IMP* origStore) {
  Method m = class_getInstanceMethod(cls, sel);
  if (m == NULL) return;
  if (*origStore == NULL) *origStore = method_getImplementation(m);
  if (class_getMethodImplementation(cls, sel) != (IMP)lin_radius) {
    class_replaceMethod(cls, sel, (IMP)lin_radius, "d@:");
  }
}

static void CallRadiusSetter(NSWindow* window, SEL sel, CGFloat radius) {
  if (![window respondsToSelector:sel]) return;
  ((void (*)(id, SEL, CGFloat))objc_msgSend)(window, sel, radius);
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
      Class realCls = object_getClass(window);

      NSImage* mask = radius > 0 ? RoundedMaskImage(radius) : nil;
      NSNumber* radiusNum = radius > 0 ? [NSNumber numberWithDouble:radius] : nil;

      // (1) frost: round the vibrancy view(s).
      RoundEffectViews([window contentView], mask);

      // (2) store the per-window radius + mask for the swizzled getters.
      objc_setAssociatedObject(window, kCornerRadiusKey, radiusNum, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      objc_setAssociatedObject(window, kCornerMaskKey, mask, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

      // (3) swizzle the radius getters (Tahoe) + _cornerMask (macOS < 26) on the
      //     real dispatch class — a KVO-observed window's actual class is a
      //     dynamic NSKVONotifying_* subclass, not [window class].
      SwizzleRadiusGetter(realCls, @selector(_cornerRadius), &g_orig_cornerRadius);
      SwizzleRadiusGetter(realCls, @selector(_effectiveCornerRadius), &g_orig_effectiveCornerRadius);
      SwizzleRadiusGetter(realCls, @selector(_topCornerRadius), &g_orig_topCornerRadius);
      SwizzleRadiusGetter(realCls, @selector(_bottomCornerRadius), &g_orig_bottomCornerRadius);
      if (g_orig_cornerMask == NULL) {
        Method base = class_getInstanceMethod([NSWindow class], @selector(_cornerMask));
        if (base != NULL) g_orig_cornerMask = method_getImplementation(base);
      }
      if (class_getMethodImplementation(realCls, @selector(_cornerMask)) != (IMP)lin_cornerMask) {
        class_replaceMethod(realCls, @selector(_cornerMask), (IMP)lin_cornerMask, "@@:");
      }

      // (4) push the value through the setters once so any cached backing field
      //     updates immediately, then nudge a recompute + shadow refresh.
      CallRadiusSetter(window, @selector(_setCornerRadius:), (CGFloat)radius);
      CallRadiusSetter(window, @selector(_setEffectiveCornerRadius:), (CGFloat)radius);
      if ([window respondsToSelector:@selector(_updateCornerMask)]) {
        ((void (*)(id, SEL))objc_msgSend)(window, @selector(_updateCornerMask));
      }
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
