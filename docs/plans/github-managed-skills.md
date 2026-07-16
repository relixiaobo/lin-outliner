# GitHub-Managed Skills

## Goal

Make Tenon a local skill manager with four distinct runtime sources:
`built-in`, `managed`, `user`, and `project`. Keep only the minimal Tenon
platform floor in the app bundle, offer optional Linlab recommendations through
a remotely refreshed catalog, and install compatible skills from arbitrary
public GitHub repositories, tree URLs, or skill subdirectories.

Managed skills execute only from a validated local copy pinned to an immutable
Git commit and whole-subtree content hash. Installing never runs skill content
or installs dependencies. Installed skills work offline and change only after
explicit enable, update, rollback, or uninstall actions.

This is shape **(a): one complete feature in one PR**. Protocol, storage,
validation, version switching, and capability boundaries land before Settings,
but none ships separately. This plan absorbs the board's unplanned
`third-party-skill-import` item, including standard frontmatter conformance.

## Non-goals

- Private repositories, GitHub credentials/tokens, GitLab, or other providers.
- Archive uploads, local-folder importing, ratings, payments, publishing, or a
  general marketplace.
- Automatic update activation or dependency installation during install/update.
- MCP/plugin lifecycle or model-facing skill-management tools.
- Editing/updating built-ins or mutating ordinary user/project skill paths and
  provenance records.
- Extra tools, folder capabilities, user-block exceptions, control-plane access,
  or a trusted execution tier for Linlab recommendations.
- Embedded shell expansion in managed `SKILL.md` files. Managed skills may ship
  non-executable text scripts; the model may invoke them later through ordinary
  tools, but Tenon never runs them while installing or rendering the skill.

## Design

### Decisions and invariants

- **BR-1:** Add a skill-specific `SkillSourceKind` with `built-in | managed |
  user | project`; do not extend `AgentSourceKind`. Keep the `SKILL.md` hash on
  `SkillDefinition` separate from the managed whole-subtree hash.
- **BR-2:** The packaged platform floor is the Tenon-owned `skillify`,
  `research`, `issue-planning`, `data-cleanup`, and private `memory-dream`
  workflows. Move `data-analysis`, `document`, `feed-processing`, `pdf`,
  `presentation`, and `spreadsheet` to optional catalog entries.
- **BR-3:** Install creates `installed-disabled`; Enable alone makes the exact
  active version eligible for slash/model resolution. Managed skills do not use
  mutable-skill Accept/Revoke/Undo actions.
- **BR-4:** Built-ins cannot be shadowed. Install fails on any built-in,
  managed, user, or project name collision with a concrete source/path. A later
  user/project collision suppresses the managed entry with `name_conflict`.
- **BR-5:** Recommended and Unverified are display/provenance labels only. The
  existing tool catalog, user blocks, folder capabilities, process executor,
  and Tenon control-plane boundary remain authoritative.
- **BR-6:** Catalog/network failure never changes installed bytes, enabled
  state, or offline invocation. Updates are detected automatically but activated
  only after preview and explicit confirmation.

### Catalog and GitHub discovery

Add schema-versioned `catalog/managed-skills-v1.json` to this repository and
refresh it from a fixed raw GitHub `main` URL. Entries contain only stable id,
display metadata, public repository, subdirectory, tracking ref, and Tenon
compatibility range. Runtime instructions and hashes always come from the
resolved repository commit. Cache the last valid catalog under private
`userData`; without a cache, refresh failure produces Catalog unavailable.

Accept only `https://github.com/{owner}/{repo}` repository/tree URLs. Resolve
default branches, slash-named branches, tags, and commit URLs through bounded
GitHub API calls, and turn every mutable ref into a 40-character commit SHA
before listing/downloading. Repository URLs discover bounded `SKILL.md`
candidates; tree/subdirectory URLs scope discovery. Multiple candidates always
require explicit selection.

Use only `api.github.com` for metadata and commit-pinned
`raw.githubusercontent.com` URLs for bytes. Requests use HTTPS, manual redirects,
host checks, timeouts, bounded streaming reads/concurrency, and concrete
rate-limit errors. No response, checkout, archive, staging directory, or update
preview is an executable runtime source.

### Compatibility and validation

Catalog entries and optional `metadata.tenon.version` use npm SemVer ranges via
the `semver` package. `app.getVersion()` must satisfy every declared range.
Missing community metadata is recorded as `unknown` and remains installable as
Unverified; explicit incompatibility blocks install. Preserve unknown
frontmatter keys. A valid `name:` is canonical, with selected-directory fallback;
always record the original repository subdirectory.

Before any content enters the managed store:

- require one strictly parsed `SKILL.md`, a valid name, and a concrete
  description; malformed YAML and duplicate names fail;
- accept only normal Git blobs with safe relative POSIX paths; reject traversal,
  symlinks, submodules, nested `.git`, Git executable modes, hidden support
  paths, native executables, and unsupported binary formats; exclude source
  metadata such as `.gitignore` instead of copying it;
- reject fenced ` ```! ` and inline `!` embedded-shell commands, while allowing
  ordinary code examples and non-executable text scripts stored without execute
  permission;
- scan all UTF-8 text for secret-looking content and verify allowlisted inert
  binary assets by signature;
- cap catalog/tree responses, inspected entries, selected file count, individual
  bytes, and aggregate bytes (initial limits: 512 KiB, 8 MiB, 20,000, 512,
  1 MiB, and 16 MiB respectively);
- hash sorted relative paths, byte lengths, and exact bytes with SHA-256.

Keep this importer validator separate from the mutable authoring gateway, which
must retain its stricter agent-written support-file rules. Return stable error
codes and the failing path/field/limit for Settings.

### Store, capabilities, and version switching

Use private control state and a separate immutable payload root:

```text
$USER_DATA/managed-skills/index.json, catalog-cache.json, staging/
$USER_DATA/managed-skill-content/{skill}/{subtree-hash}/...
```

The index records origin, subdirectory, tracking ref, installed commit/hash,
compatibility, recommendation provenance, install time, enabled state, active
version, one previous version, last checked commit, and diagnostics. It contains
no skill bytes. Product commands alone mutate both roots.

The content root is a read-only exception inside protected `userData`, but a
capability snapshot still grants only the exact enabled/invoked active version
as `origin: skill`. The control root, disabled/other versions, and all managed
paths for write remain private even if Home or `/` is granted. Managed roots are
never accepted by the mutable skill write resolver.

Install/update downloads into private staging, validates/hashes, writes without
execute bits, renames the completed candidate into a content-addressed version,
then atomically flips the index last. Serialize per skill and bind mutations to
expected hashes. Pre-flip failure leaves the prior version active; post-flip
integrity/registry failure restores it. Reclaim orphan staging/version paths.

Rehash on Settings load and immediately before invocation. A mismatch marks
`modified`, removes the skill from resolution, and blocks update/rollback.
Explicit uninstall remains available with a warning; reinstall requires
uninstall first. Managed operations can never address user/project/built-in
paths.

Update check resolves only the tracking ref and records `update_available`
without downloading or changing active bytes. Preview downloads and validates
the candidate, then shows commits, versions, hashes, changed paths, and a bounded
`SKILL.md` diff. Apply requires the exact previewed commit/hash. Keep one clean
previous version for explicit rollback. Remote disappearance never removes the
local installation.

### Runtime, Settings, packaging, and scope

Add typed management views/results and explicit commands for catalog load/
refresh, discovery, install, update check/preview/apply, enable/disable,
rollback, and uninstall. IPC inputs contain identifiers and expected hashes,
never filesystem paths. The generic preload invoke bridge remains unchanged;
main validates input and calls one managed-skill service. State changes refresh
every live and conversationless skill registry without restart.

Extract a managed-skills Settings component instead of expanding
`AgentSettingsView`. Reuse inset lists, native dialogs, shared menus/buttons,
tokens, and English/Chinese localization. Cover catalog empty/loading/cached/
unavailable, GitHub resolving/multi-select/installing/failure, and managed
installed-disabled/enabled/update-available/modified/rolled-back/uninstalling
states. Install/update/uninstall confirmations expose source, commit,
compatibility, scripts, and Unverified/Recommended status.

Remove external Linlab roots from `builtInSkillConfig`, `agentSkills`, and
`sync-built-in-skills`; packaged `extraResources` keeps only the platform floor.
Add `semver` to `package.json`/`bun.lock`. Update `agent-skills.md` and
`agent-tool-permissions.md` in the implementation PR.

Likely scope: `src/core/types.ts`, `src/core/commands.ts`, catalog/package lock;
new main catalog/GitHub/validator/store/service modules; `agentSkills.ts`,
`agentRuntime.ts`, `agentFolderCapabilities.ts`, `main.ts`, built-in sync/config;
renderer API, new Settings component/dialog, localization/styles; focused Core,
renderer, E2E, security, offline/update, and packaging tests. Do not edit
main-owned `docs/TASKS.md` or `CHANGELOG.md`.

Plan-time collision check on 2026-07-16: open Draft PR #405 (`Agent ledger
portability`) has no file diff. Its claim is separate except for a possible
narrow `agentRuntime.ts` deletion call site. Recheck before implementation; if
that file appears, rebase/order this branch after #405 and keep the changes
semantically separate. No other open PR claim overlaps. This plan absorbs
`third-party-skill-import`; `agent-skills-authoring` retains mutable
self-authoring/curation ownership.

## Open questions

- **Catalog authority.** Approval ratifies the catalog in
  `relixiaobo/lin-outliner` fetched from raw `main`. Redirecting it to
  `relixiaobo/linlab-skills` adds a cross-repository prerequisite.
- **Compatibility default.** Approval ratifies npm SemVer ranges and permits
  missing Tenon metadata as `unknown`/Unverified; only explicit incompatibility
  blocks install.
- **Modified bytes.** Approval ratifies fail-closed invocation and
  uninstall/reinstall recovery rather than executing or replacing modified
  managed content.

## Acceptance and verification

- [ ] **AC-1:** A fresh packaged resource tree contains only the Tenon platform
      floor; a Linlab recommendation installs disabled from a resolved commit.
- [ ] **AC-2:** Installed skills invoke from the pinned local hash while offline
      or after the catalog/repository disappears.
- [ ] **AC-3:** A tracked ref change shows Update available without changing
      active bytes; only confirmed Apply changes the active hash.
- [ ] **AC-4:** Failed validation/install/update/activation leaves or restores
      the prior usable version and reports rollback accurately.
- [ ] **AC-5:** Multi-skill repositories require selection; duplicate names and
      incompatible versions fail with concrete explanations.
- [ ] **AC-6:** Text scripts install without execute bits; installer/rendering
      never runs them; embedded shell, unsafe paths/modes/assets, secrets, and
      exceeded limits fail closed.
- [ ] **AC-7:** Only an invoked active managed version is readable; managed
      control state, disabled/other versions, and every managed write stay
      inaccessible under all folder grants.
- [ ] **AC-8:** User/project skills are never rewritten, removed, shadowed, or
      disabled by managed actions.
- [ ] **AC-9:** Settings covers every required catalog, discovery, install,
      disabled/enabled, update, modified, failure, rollback, and uninstall state
      in light/dark themes with localized errors and keyboard access.
- [ ] Verify focused Core/renderer/E2E/security/packaging tests, then run
      `bun run typecheck`, relevant full suites, `bun run docs:check`,
      `git diff --check`, and `bun run app:build`.
- [ ] Main gate runs `/code-review ultra`, security review, and light/dark
      visual QA before merge.
