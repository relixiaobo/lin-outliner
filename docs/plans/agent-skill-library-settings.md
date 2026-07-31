# Agent Skill Library Settings

## Goal

One place that answers *which Skills do I have, is each one on, and where did it
come from* — with acquisition behind a `+` instead of occupying the page. Make a
local Skill directory reachable from the app at all, and make an available
update visible without going looking for it.

## Non-goals

- No change to Skill format, invocation, the trust/provenance model, the tool
  ceiling, or what managed install validates and pins.
- No auto-**install** and no auto-**apply**. Availability may be surfaced;
  acquiring and applying stay explicit user actions.
- No non-GitHub managed sources.
- No copying a local Skill directory into Tenon storage. Local directories are
  **pointed at**, never imported (see Design → PR 1).
- No migration. Installed Skills are already indexed; only presentation and the
  enable predicate change.
- Not a Skill authoring surface. `skillify` and the file tools remain the way
  Skills are written.

## Shape

Shape **(b): a set of independent complete features**, three PRs.

- **PR 1 — the Skill library.** One complete feature: the unified list, the `+`
  acquisition panel, local directories, the single enable predicate, **and**
  update visibility. Its internal order is build order inside one PR (cf. A7
  foundation-before-consumers), not shippable slices:
  predicate → one list → `+` panel → local directories → update surfacing.
  Update surfacing was briefly planned as its own PR and folded back in: its
  badge attaches to the very surface this PR rebuilds, so splitting it invented
  an ordering dependency instead of removing one. Two things that must land in
  a fixed order against the same surface are one thing.
- **PR 2 — the catalog guard** (validator + test, plus the Browser Pilot
  recommendation entry). Genuinely independent: a CI guard over a data file,
  touching no UI. **Do this one first.** Not for shape purity — because
  `catalog/managed-skills-v1.json` reaches every installed Tenon from `main`
  today with nothing validating it, and parking that behind a settings redesign
  leaves a live artifact unguarded for no reason. It is small enough to
  fast-track.

## Current state (verified against `main`, 2026-07-31)

- **The page is split by provenance, which is an implementation detail.**
  `AgentSettingsView.tsx:980-1010` renders `<ManagedSkillsSettings/>` and then a
  second list, `allSkills.filter((skill) => skill.source !== 'managed')`. A user
  thinks "my Skills"; where one came from is an attribute, not a category.
- **Acquisition is permanent page furniture.** `ManagedSkillsSettings.tsx`
  stacks always-visible groups: catalog (`:282`), a GitHub URL input (`:334`),
  installed managed Skills (`:370`), and the discovery/preview panel (`:500`).
  Together with the non-managed list that is four or five top-level groups where
  there should be one list and one `+`.
- **Two enable mechanisms.** `agentSkills.ts:587-589`
  (`isDisabledByRuntimeSettings`) reads `disabledSkills` — a settings array keyed
  by name — and **explicitly excludes managed Skills**. Managed Skills instead
  carry their own activation state in the managed index, which is load-bearing
  for #406's "install disabled, then enable" flow. `built-in`, `user`, and
  `project` are all covered by `disabledSkills`, so built-ins **can** be disabled
  today.
- **Local Skill directories are unreachable from the app.**
  `additionalSkillDirectories` exists in `core/types.ts:718`, is normalized in
  `agentSkills.ts:810`, and is applied at `main.ts:483/567/667/3392` — but no
  renderer surface writes it. It is settings-file-only.
- **Updates are discovered only if you open the page.**
  `managedSkillService.checkUpdates()` (`:339`) resolves each record's
  `trackingRef` to a commit and sets `updateCommit` when it differs. Its only
  callers are `ManagedSkillsSettings.tsx:72/170` — section load and an explicit
  button. Each record already stores `lastCheckedAt`, so a throttle has a home.
- **The live catalog is unguarded.** `managedSkillService.ts:35` fetches
  `https://raw.githubusercontent.com/relixiaobo/lin-outliner/main/catalog/managed-skills-v1.json`
  at runtime on every `loadCatalog()`, with a local cache fallback. Nothing in
  `tests/` or `scripts/` validates that file, yet it is served from `main` to
  every installed Tenon: a malformed push degrades existing installs to `cached`
  and gives new installs nothing.

## Design

### PR 1 — One library, acquisition behind `+`

**One list, one row shape, every source.** Sources rendered together:
`built-in`, `user`, `project`, local directory, `managed`. Each row carries the
`/name`, description, a source chip, the existing trust chip, and an enable
toggle. Source-specific actions live in the row's disclosure, not in separate
sections.

**The enable predicate is unified; the writers are not.** Do not merge the two
stores — `disabledSkills` is user settings keyed by name, while the managed
index's activation flag is per-installed-record and participates in
install/rollback/uninstall. Merging would make settings hold managed lifecycle
state, or make the managed index hold settings for Skills it does not own.
Instead:

```
enabled(skill) = activation(skill) && !disabledSkills.includes(skill.name)
```

where `activation` is the managed index flag for `managed` and constant-true for
every other source. One meaning of "on" — *available to the model right now* —
one predicate, two writers. The toggle routes by source; the UI never branches
on source for what the toggle *means*.

**`+` opens one acquisition panel, not three menu items.** Browsing the
recommended catalog and pasting a GitHub URL are two inputs to the same act, so
they belong in one overlay: the recommended list first, a URL field below it,
and the existing compatibility/integrity review before install. The `+` menu
therefore has two entries:

1. **添加 Skill** — the acquisition panel above (catalog + GitHub URL).
2. **添加本地目录** — a native directory picker appending to
   `additionalSkillDirectories`.

**Local directories are pointed at, never copied.** The directory stays the
user's: edits are live, there is no snapshot to drift, and removal only unlinks.
Rows sourced from one get a `local` chip and a **移除目录** action that unlinks
and never touches files. This matches how the setting already behaves; "import"
would introduce a second, copying semantics for the same concept.

**Row disclosure actions by source:**

| Source | Actions |
|---|---|
| `managed` | check update, preview update, apply, rollback, uninstall (existing service calls, unchanged) |
| local directory | reveal in Finder, remove directory (unlink only) |
| `user`, `project` | existing trust actions — accept, revoke acceptance, undo agent edit |
| `built-in` | none; enable toggle only |

One list-level empty state replaces the current per-group empty states.

**Design system.** `+` is an icon-only chrome control → B6: it deepens colour on
hover/active with no box; if a fill is truly needed it is pill or circular,
never a rounded square. The acquisition panel is an overlay → B5 material with a
`prefers-reduced-transparency` opaque fallback, B10 tiered elevation (level-2 for
a dialog-class surface), and it must be registered in the
`typography-tokens.spec.ts` material allowlist in the same change — an
unregistered material surface is exactly what turned that guard red on `main`
until #464 registered `.thread-jump-latest`. No
`cursor: pointer` on non-links. Rows must not reflow on hover (B7).

**Files:** `AgentSettingsView.tsx`, `ManagedSkillsSettings.tsx` (stops being a
top-level group stack; becomes the acquisition panel plus managed row actions),
`SettingsInsetList.tsx` if a disclosure row is needed, `thread.css`/settings CSS,
i18n `en.ts` + `zh-Hans.ts`, and a new settings IPC pair for adding/removing an
`additionalSkillDirectories` entry. `agentSkills.ts` changes only if the unified
predicate is placed there rather than in the renderer's view model — prefer main,
so the model-facing catalog and the UI cannot disagree about what is enabled.

#### PR 1, final step — an update you do not have to go looking for

- **Throttle on the existing record field.** Check at most once per record per
  window using `lastCheckedAt`; recommend **6 hours**. Trigger at app start once
  the app is idle, plus the existing on-open path. No periodic polling while the
  app sits open.
- **Surface: a count badge on the Skills row in the settings navigation.** No
  modal, no OS notification, no auto-apply. The badge means "N Skills have an
  update available"; clicking through lands on the library with those rows
  marked.
- **Failure is silent and recorded.** `recordUpdateFailure` already exists. A
  network failure at startup must never block launch, show a toast, or change
  any Skill's enabled state — it degrades and records (A12).
- Explicitly not in scope: auto-update, background download, update-on-schedule.

### PR 2 — The catalog is a production artifact; guard it

`catalog/managed-skills-v1.json` is fetched live from `main` by every installed
Tenon. It is the only file in this repository whose contents reach users without
a release, and nothing validates it.

- Add a validator + test that runs in the normal suite: `schemaVersion` matches
  the runtime constant; every entry has `id`, `name`, `description`,
  `repository`, `subdirectory`, `trackingRef`, `compatibilityRange`; `id` unique;
  `repository` is an `https://github.com/…` URL; `compatibilityRange` is a valid
  SemVer range; `name` matches the managed skill-name pattern
  (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`); total bytes under
  `MANAGED_SKILL_LIMITS.catalogBytes`.
- **Reuse `parseCatalogDocument`** from `managedSkillService.ts` rather than
  writing a second parser, so the guard and the runtime loader cannot drift. If
  it is not exported, export it; do not copy it.
- **Browser Pilot recommendation entry.** Add once its maintainer supplies
  repository, subdirectory, and tracking ref:

  ```json
  {
    "id": "browser-pilot",
    "name": "browser-pilot",
    "description": "…",
    "repository": "https://github.com/<owner>/browser-pilot",
    "subdirectory": "<dir containing SKILL.md>",
    "trackingRef": "main",
    "compatibilityRange": ">=0.1.0 <1.0.0"
  }
  ```

  This is a data change gated on an external party and is **not a blocker for
  this PR** — ship the guard, add the entry when the values arrive. Tenon ships no
  Browser Pilot binary and requires no code for this: the Skill it installs owns
  its own preflight and version pairing (`docs/spec/agent-skills.md` →
  *Third-Party Tool Integration*).

## Risks

- **Unified predicate changes what is enabled.** If `enabled()` is written
  wrong, Skills silently vanish from or appear in the model's catalog. The
  predicate must be covered by a test per source, including a managed Skill that
  is installed-but-not-activated *and* named in `disabledSkills`.
- **The `+` panel is a new material overlay.** Shipping it without registering
  it in the material-surface allowlist reproduces the current red guard on
  `main`; shipping it without a `prefers-reduced-transparency` fallback violates
  B5 and will not be caught by that guard.
- **Local directory removal must never delete files.** A "remove" that unlinks
  and a "remove" that deletes look identical in a row menu. The label and the
  handler must both say unlink.
- **Startup update check touches the network.** It must be genuinely
  fire-and-forget: no await on the launch path, no error surface.

## Open questions

1. Should a `built-in` Skill's toggle be shown even though it cannot be
   uninstalled? Verified that `disabledSkills` already covers `built-in`
   (`agentSkills.ts:588` excludes only `managed`), so disabling works today —
   the question is only whether exposing it invites confusion. Recommendation:
   show it; hiding a capability the settings file already has is worse.
2. The 6-hour throttle window and the app-start trigger point are proposals, not
   measurements. If startup cost is measurable, move the check behind first
   settings open and keep only the badge.

## Verification

- Unit: the unified `enabled()` predicate across all five sources, including
  installed-but-not-activated managed, and a managed Skill named in
  `disabledSkills`.
- Unit: catalog validator rejects each malformed shape it claims to reject, and
  accepts the checked-in file.
- Unit: `checkUpdates` throttle honours `lastCheckedAt`; a failing network call
  records and does not mutate enabled state.
- Renderer: one list renders every source with the right chips and the right
  disclosure action set; `+` opens the acquisition panel; local-directory add and
  remove round-trip through settings.
- E2E: add a local directory, see its Skills appear and be invocable; install
  from a stubbed catalog; toggle a built-in off and confirm it leaves the model
  catalog.
- Visual verification in **light and dark**, plus `prefers-reduced-transparency`
  and `prefers-reduced-motion`.
- `bun run typecheck`, `test:core`, `test:renderer`, relevant e2e, `docs:check`.
  `main`'s e2e baseline was restored in #464, so `test:e2e` is a clean signal
  again — a red spec on this branch is this branch's.
- Update `docs/spec/agent-skills.md` (Settings section) in the same change.
