// macOS native addon: read the URL + title of the browser window the user is
// ACTUALLY focused on, via the Accessibility (AX) API, targeting a specific
// process by PID.
//
// Why this exists (docs/plans/lazy-like-global-launcher.md → capture accuracy):
//   AppleScript addresses a browser by *bundle id* and reads `active tab of front
//   window`. That breaks in two real cases:
//     1. multiple windows — "front window" is the app's internally-frontmost
//        window, not guaranteed to be the one the user sees;
//     2. multiple instances of the same browser (two profiles / --user-data-dir)
//        — AppleScript can only address ONE instance per bundle id, so it may
//        read the wrong instance entirely.
//   The AX API fixes both: AXUIElementCreateApplication(pid) targets the EXACT
//   process, and kAXFocusedWindowAttribute is the window with key focus. We then
//   walk that window's subtree for kAXURLAttribute (Chrome's AXWebArea / Safari's
//   web area expose it). This is the route reliable launchers (Alfred, Raycast)
//   converge on; it requires the Accessibility TCC grant.
//
// Degradation: every entry point returns a typed result/error and never throws;
// the orchestrator falls back to the AppleScript path when AX is untrusted or
// returns nothing. Compiled with plain Node-API C headers, no ARC.

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>

// Bounds for the focused-window subtree walk. The web area carrying the URL sits
// a handful of levels below the window for both Chrome and Safari, so a shallow,
// budgeted DFS finds it without traversing a browser's entire (possibly huge)
// accessibility tree. Each AX read is a synchronous IPC to the target app, so the
// budget — together with the per-app messaging timeout — caps total time.
static const int kMaxDepth = 7;
static const int kMaxChildrenPerNode = 40;
static const int kMaxNodeBudget = 300;

static napi_value CFStringToNapi(napi_env env, CFStringRef s) {
  napi_value out;
  if (s == NULL) {
    napi_get_null(env, &out);
    return out;
  }
  CFIndex length = CFStringGetLength(s);
  CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  char stackBuf[1024];
  char* buf = stackBuf;
  bool heap = false;
  if (maxSize > (CFIndex)sizeof(stackBuf)) {
    buf = (char*)malloc((size_t)maxSize);
    heap = true;
  }
  if (buf != NULL && CFStringGetCString(s, buf, maxSize, kCFStringEncodingUTF8)) {
    napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  } else {
    napi_get_null(env, &out);
  }
  if (heap) free(buf);
  return out;
}

static void SetStringProp(napi_env env, napi_value obj, const char* key, const char* value) {
  napi_value v;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, key, v);
}

// Depth-first search for the first element exposing kAXURLAttribute. Returns a
// retained CFStringRef (caller releases) or NULL. `budget` is shared across the
// whole walk so a wide tree cannot blow the time bound.
static CFStringRef CopyURLFromElement(AXUIElementRef el, int depth, int* budget) {
  if (el == NULL || depth > kMaxDepth || *budget <= 0) return NULL;
  (*budget)--;

  CFTypeRef urlVal = NULL;
  if (AXUIElementCopyAttributeValue(el, kAXURLAttribute, &urlVal) == kAXErrorSuccess && urlVal != NULL) {
    CFStringRef out = NULL;
    CFTypeID type = CFGetTypeID(urlVal);
    if (type == CFURLGetTypeID()) {
      CFStringRef u = CFURLGetString((CFURLRef)urlVal);
      if (u != NULL) out = (CFStringRef)CFRetain(u);
    } else if (type == CFStringGetTypeID()) {
      out = (CFStringRef)CFRetain(urlVal);
    }
    CFRelease(urlVal);
    if (out != NULL) return out;
  }

  CFTypeRef childrenVal = NULL;
  if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenVal) == kAXErrorSuccess
      && childrenVal != NULL) {
    if (CFGetTypeID(childrenVal) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)childrenVal;
      CFIndex count = CFArrayGetCount(children);
      if (count > kMaxChildrenPerNode) count = kMaxChildrenPerNode;
      for (CFIndex i = 0; i < count && *budget > 0; i++) {
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
        CFStringRef found = CopyURLFromElement(child, depth + 1, budget);
        if (found != NULL) {
          CFRelease(childrenVal);
          return found;
        }
      }
    }
    CFRelease(childrenVal);
  }
  return NULL;
}

// getFocusedTab(pid: number) -> { url: string|null, title: string|null, error: string|null }
static napi_value GetFocusedTab(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  napi_value result;
  napi_create_object(env, &result);
  napi_value nullVal;
  napi_get_null(env, &nullVal);
  napi_set_named_property(env, result, "url", nullVal);
  napi_set_named_property(env, result, "title", nullVal);
  napi_set_named_property(env, result, "error", nullVal);

  int32_t pid = 0;
  if (argc < 1 || napi_get_value_int32(env, args[0], &pid) != napi_ok || pid <= 0) {
    SetStringProp(env, result, "error", "invalid-pid");
    return result;
  }

  if (!AXIsProcessTrusted()) {
    SetStringProp(env, result, "error", "ax-not-trusted");
    return result;
  }

  AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
  if (app == NULL) {
    SetStringProp(env, result, "error", "ax-app-failed");
    return result;
  }
  // Never let a slow/hung renderer block the capture path (this runs as a sync
  // call on the main process).
  AXUIElementSetMessagingTimeout(app, 0.4f);

  AXUIElementRef window = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, (CFTypeRef*)&window) != kAXErrorSuccess
      || window == NULL) {
    // Background apps sometimes expose only a main window, not a focused one.
    AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, (CFTypeRef*)&window);
  }
  if (window == NULL) {
    CFRelease(app);
    SetStringProp(env, result, "error", "ax-no-window");
    return result;
  }

  CFStringRef title = NULL;
  if (AXUIElementCopyAttributeValue(window, kAXTitleAttribute, (CFTypeRef*)&title) == kAXErrorSuccess
      && title != NULL) {
    napi_set_named_property(env, result, "title", CFStringToNapi(env, title));
    CFRelease(title);
  }

  int budget = kMaxNodeBudget;
  CFStringRef url = CopyURLFromElement(window, 0, &budget);
  if (url != NULL) {
    napi_set_named_property(env, result, "url", CFStringToNapi(env, url));
    CFRelease(url);
  }

  CFRelease(window);
  CFRelease(app);
  return result;
}

// accessibilityTrusted() -> boolean. Does not prompt.
static napi_value AccessibilityTrusted(napi_env env, napi_callback_info info) {
  napi_value r;
  napi_get_boolean(env, AXIsProcessTrusted(), &r);
  return r;
}

// promptAccessibility() -> boolean. Triggers the system "grant Accessibility"
// prompt (and adds the app to the Privacy list) when not yet trusted; returns the
// current trust state.
static napi_value PromptAccessibility(napi_env env, napi_callback_info info) {
  const void* keys[] = { (const void*)kAXTrustedCheckOptionPrompt };
  const void* values[] = { (const void*)kCFBooleanTrue };
  CFDictionaryRef options = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  Boolean trusted = AXIsProcessTrustedWithOptions(options);
  CFRelease(options);
  napi_value r;
  napi_get_boolean(env, trusted, &r);
  return r;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fnFocused, fnTrusted, fnPrompt;
  napi_create_function(env, "getFocusedTab", NAPI_AUTO_LENGTH, GetFocusedTab, NULL, &fnFocused);
  napi_set_named_property(env, exports, "getFocusedTab", fnFocused);
  napi_create_function(env, "accessibilityTrusted", NAPI_AUTO_LENGTH, AccessibilityTrusted, NULL, &fnTrusted);
  napi_set_named_property(env, exports, "accessibilityTrusted", fnTrusted);
  napi_create_function(env, "promptAccessibility", NAPI_AUTO_LENGTH, PromptAccessibility, NULL, &fnPrompt);
  napi_set_named_property(env, exports, "promptAccessibility", fnPrompt);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
