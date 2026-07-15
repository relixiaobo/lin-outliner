# URL Preview Persistent Session

## Goal

Make URL Preview Tenon's only user-visible web browsing surface. Every URL
Preview pane shares one Tenon-owned persistent browser profile, so a user can
sign in directly inside Preview, keep ordinary website sessions across panes
and app restarts, watch signed-in media, and clear all retained website data
from Settings.

This is shape **(a)**: one complete feature in one PR. Future agent browser
control may attach to these visible Preview guests, but it must not introduce a
second browser UI, external Chromium profile, or separate user-facing session.

## Non-goals

- Importing or copying Chrome/Chromium profiles, cookies, saved passwords,
  history, autofill data, extensions, or open tabs.
- Providing a password manager, credential autofill, profile picker, address
  bar, tab strip, or general-purpose browser mode.
- Claiming support for passkey-only authentication. Electron's macOS system
  passkey work is not available in the pinned release, and arbitrary relying
  parties require platform/browser entitlements outside this change.
- Improving the at-rest protection of unsigned builds. They continue to use
  Chromium's mock keychain; persistent website sessions therefore remain a
  pre-release/local-device capability until signed packaging is ratified.
- Exposing cookies, storage, page credentials, or a CDP endpoint to the renderer
  or agent runtime.

## Design

### One Persistent Preview Profile

Replace the in-memory `url-preview` partition with
`persist:url-preview`. Main creates and configures that session once before any
guest attaches; every renderer webview and attach-time override uses the exact
same partition. The profile remains inside the already-isolated Electron
`userData` directory, so development clones and the packaged app do not share
website state.

The session retains Chromium-managed cookies and site storage. It does not add
application-owned credential persistence. App shutdown flushes both DOM storage
and the cookie store within the existing bounded before-quit drain.

### Security Boundary

Keep the existing remote-content boundary: HTTP(S)-only navigation,
`contextIsolation`, sandbox, Node disabled in every frame and worker, no preload,
web security enabled, no plugins, no insecure content, no drag navigation, and
no renderer access to the session object. Configure permissions once on the
persistent session and allow only `fullscreen` and
`clipboard-sanitized-write`; deny camera, microphone, geolocation,
notifications, raw clipboard reads, and every unknown permission.

The existing explicit **Open in browser** menu remains an escape hatch. Website
GET popup/new-window requests no longer open the system browser implicitly:
main validates the target and navigates the requesting Preview guest in place
while still returning `deny` from `setWindowOpenHandler`. Unsupported schemes,
POST popups, and malformed targets stay blocked. This keeps A3's child-window
denial and one visible web surface; popup flows that require an opener are not a
claimed capability.

### Clear Website Data

Add one **Website data** row to Settings > General with a **Clear** action and a
native confirmation dialog. The main process clears cookies, cache, service
workers, and all site storage for only the persistent URL Preview partition,
then reloads attached Preview guests. The command returns a small typed success
or failure result and never exposes stored data.

### Existing Preview Interaction

Do not add browser chrome. Preview keeps its existing breadcrumb, translation
control, actions menu, pane routing, and explicit external-open action. Session
persistence must not remount the guest during normal renders or add new React
subscriptions beyond the existing webview ref lifecycle.

### Future Browser Control Direction

Revise the pending Browser Control plan so its backend discovers and attaches
to Tenon-owned URL Preview guest `webContents` through main-process Electron CDP
facilities. Remove the external Chrome/Edge/Brave profile-discovery and Pilot-tab
product direction. Browser Control remains separately gated and is not
implemented by this PR.

## Files And Ownership

- Session/runtime: `src/main/urlPreviewSession.ts`, `src/main/main.ts`.
- Bridge and UI: `src/preload/index.ts`, `src/renderer/ui/agent/AgentSettingsView.tsx`,
  URL Preview renderer code, Settings styles, and English/Chinese messages.
- Tests: focused Core security/session tests, renderer Settings/Preview tests,
  and an Electron smoke that verifies persistence across a real relaunch.
- Current behavior: `docs/spec/workspace-layout.md` and
  `docs/plans/file-preview.md`.
- Future direction only: `docs/plans/agent-browser-control.md` and
  `docs/plans/browser-extension-integration.md` where their external-browser
  assumptions conflict with the ratified product boundary.

No infrastructure-ownership or core protocol file is required. The main agent
will add the board and changelog entries at merge.

## Risks

- Authenticated cookies are bearer credentials. Unsigned builds use a static
  mock-keychain key, so filesystem permissions are their primary local boundary.
- A persistent partition can accumulate cache and service-worker state; the
  clear-data action and bounded quit flush are therefore part of the feature,
  not follow-ups.
- Shared session configuration must be idempotent because multiple Preview
  guests can attach concurrently.
- Same-surface popup routing intentionally gives up opener-dependent popup
  semantics. Direct top-level website login is the supported path.
- Google/YouTube smoke testing can establish that the login UI and playback stay
  inside Preview, but passkey-only completion remains outside acceptance.

## Collision Result

Checked 2026-07-15 after rebasing onto `origin/main`. PR #396 is merged and is
the implementation baseline. Open PR #397 does not touch the session, Preview,
Settings, workspace-layout spec, or browser-control plans; its only nearby file
is a separate `docs/spec/ui-behavior.md` section, which this change need not
edit. No live claim overlaps the implementation scope.

## Validation

- Unit-test the partition name, one-time session hardening, permission allowlist,
  popup routing, clear-data behavior, failure handling, and quit flush.
- Renderer-test the General-pane clear action, busy state, confirmation cancel,
  success notice, and error notice without extra rerenders or layout shifts.
- Electron smoke with a local HTTP fixture: set Secure/HttpOnly-compatible
  cookies plus local storage, close the app, relaunch with the same isolated
  `userData`, and verify both are present in a new Preview pane; then clear data
  and verify they are absent after reload and another relaunch.
- Manually verify YouTube signed-out rendering, direct sign-in navigation up to
  the available account challenge, normal playback, fullscreen, explicit Open
  in browser, and a GET `_blank` link staying in Preview.
- Run `bun run typecheck`, relevant Core/renderer/smoke suites,
  `bun run docs:check`, and `git diff --check`; inspect Settings in light and
  dark themes.

## Open Questions

None. The PM ratified the single-Preview profile, no-import, no-second-browser,
and explicit passkey/mock-keychain limitations before implementation.

## Subtasks

- Add and configure the persistent URL Preview session.
- Flush it during bounded app shutdown.
- Route supported new-window requests back into the requesting Preview guest.
- Add the clear-data main operation, preload bridge, native confirmation, and
  General-pane row.
- Update current specs and pending browser plans.
- Add unit, renderer, relaunch smoke, and visual verification.
