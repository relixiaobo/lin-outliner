# Update Check And Settings Status

## Goal

Let a person using an unsigned packaged Tenon build discover the newest stable
release and open its `.dmg` without revisiting GitHub. Discovery stays passive:
Tenon checks quietly, and the only ambient UI is a small update-status dot inside
Settings. The person chooses when to open About, inspect the release, recheck, and
download it.

This is shape **(a): one complete feature in one PR**. Service, persistence, IPC,
Settings UI, localization, tests, and current-spec updates ship together.

## Non-goals

- No main-window banner, toast, dialog, notification, or dock badge.
- No skip-version, remind-later, dismissal, or unread/read lifecycle.
- No automatic download, installation, relaunch, rollback, signing, or
  notarization. Those belong to `signed-builds-and-auto-update`.
- No prerelease channel, release history browser, telemetry, account, or GitHub
  authentication.
- No change to release cadence, release-note authoring, `package.json`, or the
  release workflow.

## Design

### Product Rules

- **BR-1:** Automatic checks are enabled by default for packaged builds and make
  at most one network attempt in any six-hour window. The first attempt starts
  asynchronously after the first application window exists; startup never awaits
  it. An explicit About-page check bypasses the throttle.
- **BR-2:** Each attempt has a five-second deadline. Ambient failure is invisible
  and preserves the last valid result. An explicit failure is reported only
  inline in About and leaves the same cached result intact.
- **BR-3:** The available release is the highest valid stable SemVer in a bounded
  GitHub Releases response, not the first response entry and not a sequence of
  missed trains. A person three trains behind sees one status for the newest
  train.
- **BR-4:** The update dot is presence-based status, not an unread notification.
  Opening About does not clear it. It disappears only when the running version is
  at least the cached release version, or automatic checks are disabled.
- **BR-5:** Disabling automatic checks stops scheduled requests and hides the
  status dots. About still offers an explicit check. Re-enabling schedules an
  immediate non-blocking refresh.
- **BR-6:** Download means opening the selected release's validated `.dmg` URL in
  the default browser. The UI says "Download update" rather than claiming Tenon
  will install it.

### Update State And Persistence

Electron main owns one decoded update snapshot and its persistence under isolated
`userData`. The persisted record is versioned and contains only the automatic-check
preference, last attempt time, and the last valid release metadata needed by
Settings. It is inspection-only state: a missing, stale, or malformed file resets
to defaults and records diagnostics rather than blocking startup or user work.

The renderer receives a presentation-safe snapshot with the running version,
automatic-check preference, check phase, last successful check time, and an
optional available release containing its version, publication time, parsed user
note, and whether a direct download is available. URLs remain main-owned; renderer
actions name `check`, `set automatic checks`, or `open download` instead of sending
an arbitrary URL back across IPC.

On launch, a cached release at or below the running version is retired. A failed
refresh never erases a newer cached release. A successful refresh with no release
newer than the running build clears stale availability.

### Release Discovery And Validation

Main requests a bounded list of public releases from the fixed
`relixiaobo/lin-outliner` GitHub API endpoint. It strictly decodes the response,
ignores drafts, prereleases, invalid tags, and releases without a safe destination,
then selects the highest SemVer newer than `app.getVersion()`.

For a newly selected version, main reads `CHANGELOG.md` at that exact validated tag
and extracts the matching user-register note with the same
`parseChangelogReleases` contract used by What's New and release publishing. Note
fetch or parse failure degrades to honest version/download status rather than
hiding a known update. A cached note is reused while the selected version is
unchanged.

The direct asset must be a `.dmg` belonging to the selected release, and its URL
must remain on GitHub's expected HTTPS release-download path. The release page is
the safe fallback when a valid release has no usable direct asset. Remote Markdown
is rendered with HTML disabled and controlled external-link handling; it cannot
create renderer-side network or script capabilities.

### Settings Flow

#### FLOW-1: Discover And Download An Update

- **Entry path:** Open Settings by any existing route.
- **Entry state:** A quiet background check has cached a stable release newer than
  the running build and automatic checks remain enabled.
- **Visible state:** A small rose status dot appears beside General in the category
  rail and beside About in the General page. Its accessible name states that a
  Tenon update is available; no update UI exists outside Settings.
- **Mainline:** Open About, compare installed and available versions, read the
  release's user note, then choose Download update.
- **Result:** Main opens the validated `.dmg` destination externally. Availability
  remains truthful until a newer build actually runs.
- **Failure/recovery:** A failed external open is shown inline in About and can be
  retried. It never becomes the app-wide action notice.

#### FLOW-2: Check Or Configure Updates

- **Entry path:** Settings > General > About.
- **Visible states:** checking, up to date, update available, automatic checks off,
  and explicit-check failure. The page shows the last successful check when one
  exists.
- **Mainline:** The person can check immediately or toggle automatic checks.
- **Failure/recovery:** Explicit failure keeps the action available and retains any
  previously known release. Ambient failure adds no visible error state.

### Settings Presentation

The existing Settings shell owns one update subscription so category and page
consumers do not register duplicate global IPC listeners. It derives the single
`updateAvailable` boolean and passes only that/status data to General and About.

The dot is a fixed-size circle using the sparse rose accent token as meaningful
status, with no number, raw color, layout-changing hover, or animation. It appears
inside the row/category control so the whole destination remains one hit target.
About keeps the running build's existing What's New group and adds a separate
Update group; remote release copy never replaces or relabels the installed build's
own note.

### Implementation Boundaries

- Add a pure Core update contract for response decoding, SemVer selection, public
  state, and IPC channel names without changing document commands or types.
- Add an isolated main-process update store/service with injected clock and fetch
  seams, then register its narrow IPC and non-blocking scheduler from `main.ts`.
- Extend the app preload only; the launcher preload gains no update capability.
- Subscribe once in `AgentSettingsView`, project status to
  `SettingsGeneralSection` and `SettingsAboutSection`, and reuse a hardened release
  note renderer.
- Update English and Simplified Chinese messages plus the architecture, Settings,
  and notification-layer specifications. Do not edit the main-owned task board or
  changelog on the development branch.

### Acceptance Criteria

- **AC-1:** When a packaged build is behind multiple stable releases, the next due
  ambient check shall leave startup responsive and expose only the highest version
  inside Settings.
- **AC-2:** When an update is available and automatic checks are enabled, General
  and About shall carry an accessible rose dot; no main-window update surface shall
  render.
- **AC-3:** When About is opened, viewing the update shall not clear either dot.
- **AC-4:** When automatic checks are disabled, scheduled checks and dots shall stop
  while explicit Check for updates remains available.
- **AC-5:** When an explicit check is requested, it shall bypass the six-hour
  throttle and render checking, up-to-date, available, or inline-failure state.
- **AC-6:** If an ambient request times out or fails, startup, the composer, and
  Settings outside About shall remain unchanged, while the last valid release stays
  cached.
- **AC-7:** When Download update is chosen, main shall open only the destination
  derived from its validated cached release; renderer-supplied URLs shall not be
  accepted.
- **AC-8:** When the running version catches up to or exceeds the cached release,
  availability and its dots shall clear on the next launch/read.
- **AC-9:** The Settings states shall remain legible and operable in light, dark,
  keyboard-focus, reduced-motion, and increased-contrast modes.

## Open Questions

None. The PM selected Settings-only passive discovery; prompt and dismissal policy
are intentionally absent.

## Build And Verification

- [ ] Implement and unit-test response decoding, release selection, throttling,
  timeout, cache retention, preference changes, and safe external opening.
- [ ] Implement the preload contract and Settings-only status/UI states with focused
  renderer tests, including one shared subscription.
- [ ] Update current specs and guard tests without weakening design-system rules.
- [ ] Run typecheck, Core tests, renderer tests, docs check, diff check, and focused
  E2E coverage.
- [ ] Verify Settings visually in light and dark themes with update-available,
  up-to-date, disabled, checking, and explicit-failure fixtures.
