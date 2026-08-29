# Desktop Host Platform Composition

**Shape:** ONE complete internal refactor in one PR.

## Goal

Move Electron-native resource/preview and application/window ownership out of
`main.ts` into typed platform hosts, leaving only explicit orchestration for the
final DesktopHost cutover.

This combines two sides of the same native boundary: one owns OS/network/file
effects used by content surfaces; the other owns the windows and app services
that publish those surfaces. Each side remains a named child owner inside the
PR rather than becoming one undifferentiated service bag.

## Non-goals

- No final `DesktopHost`, lifecycle arbiter, startup reorder, or quit policy
  change.
- No preview feature, Source UI enhancement, update behavior fix, or Settings/
  Launcher redesign.
- No renderer filesystem/network authority and no public protocol change.
- No generic application database or cross-domain state store.

## Design

### Resource and preview host

`createResourcePreviewHost()` owns final Source exact-file grants/resolution,
native picker/search/read/copy, preview streams, URL-preview session,
translation, extraction/cache services, and their reversible effects. It
preserves mature preview actions and the verified-handle authority from
`outline-source-model`.

### Window and application hosts

Typed owners cover Main, Settings, Provider Config, and Launcher windows plus
action invocation, update checks, theme/locale/preferences, menu, hotkey,
activation, and window-scoped effects. Window/WebContents listeners stay with
their window owner; global app effects expose explicit release.

`main.ts` still constructs the domain and platform hosts and sequences current
startup/quit behavior. Optional update, cache, translation, and managed-Skill
refresh failures retain bounded degradation and cannot delay first-window work
more than they do on the merged baseline.

### Dependencies and collisions

`host-domain-composition` lands first. `desktop-host-cutover` consumes these
final owners. Source preview, file-preview extensions, update-check follow-ups,
theme/i18n work, and preview-jank units wait or repeat the live file collision
check; this refactor does not absorb their behavior changes.

### Verification

Tests cover exact-file narrowing, protocol/stream cleanup, preview cancellation,
window close/reopen, menu/hotkey/theme/locale/update ownership, and repeated
release. The responsibility audit classifies all native effects and proves no
duplicate listener, timer, protocol, or application-service owner.

### Acceptance criteria

- Resource/preview and window/application construction no longer live in
  `main.ts`.
- Existing preview, file authority, window, menu, hotkey, update, theme, and
  locale behavior is unchanged.
- Every extracted native effect has a named idempotent release path.
- No later feature behavior or renderer authority is introduced as part of the
  refactor.

## Open questions

None.

## Implementation checklist

- [ ] Re-derive platform effects and application-service owners from source.
- [ ] Extract resource/preview and window/application hosts.
- [ ] Preserve current optional-failure and security boundaries.
- [ ] Extend the audit and run focused, E2E, docs, and visual smoke checks.
