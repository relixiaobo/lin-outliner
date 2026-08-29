# Agent Skill Authoring And Maintenance

**Shape:** (b) A SET of two independent complete features: executable support-
file authoring and opt-in curation reporting. Each ships in its own PR.

## Goal

Finish the two unimplemented Skill maintenance capabilities on the canonical
Agent Core:

- allow an explicit `skillify` workflow to author validated textual scripts
  without granting execution authority; and
- provide an opt-in, read-only curation report for model-authored Skills.

A Skill remains a local instruction bundle, not an Agent identity, permission
container, execution record, or persistence root.

## Non-goals

- No model-facing Skill CRUD family; authoring continues through `skillify` and
  ordinary file tools.
- No background model that silently rewrites, merges, archives, or deletes
  Skills.
- No Skill sandbox, approval state, capability-acquisition path, or mutable
  built-in/managed content.
- No marketplace, plugin, MCP, migration, compatibility, or scheduling work.

## Design

### Requirements

- **FR-1:** Only an explicit root-user `skillify` invocation can mint a
  Turn-scoped executable-support authoring admission.
- **FR-2:** Authoring a script never changes the effective tool catalog,
  permission policy, or a child's capability ceiling.
- **FR-3:** Curation is read-only, hash-bound, and excludes content whose source
  or provenance does not permit a reliable recommendation.
- **FR-4:** `built-in` and `managed` Skills remain immutable through every path
  introduced by this plan.

### Current source and ownership model

Canonical Skill source is exactly one of `built-in`, `managed`, `user`, or
`project`.

| Source | Ownership | Authoring/curation behavior |
| --- | --- | --- |
| `built-in` | packaged immutable floor | never writable; excluded from curation mutation candidates |
| `managed` | installed, pinned upstream content | never writable through `skillify`; update/rollback remains managed-Skill service authority |
| `user` | configured user root | writable when the resolved path and provenance gates pass |
| `project` | active-worktree Skill root | writable when project path authority and provenance gates pass |

Discovery mode is not another source. Symlink-equivalent Skill files deduplicate
by canonical identity. Thread/Role selection may narrow the effective Skill set
but cannot widen the parent capability ceiling.

### Feature 1: executable support files

Replace the current blanket `EXECUTABLE_SUPPORT_EXTENSIONS` rejection with one
Turn-scoped authoring admission issued only by an explicit root-user
`skillify` request. The admission names the mutable Skill identity, file path,
purpose, inputs/outputs, and canonical tool expected to execute it later.

A write commits only when the target remains inside that `user` or `project`
Skill, is not hidden or symlink-escaped, is an allowlisted UTF-8 text script,
fits the support-file budget, contains no binary/NUL content or recognized
secret, and leaves the complete Skill bundle valid. The authoring gateway owns
atomic single-file replacement, previous-content provenance, bundle hashing,
reference validation, and registry refresh.

Writing a script grants no execution right. A later run still requires the
ordinary shell/process tool, current explicit blocks, effective capability
ceiling, Full Access policy, and native OS behavior. Children cannot inherit the
authoring admission. Native binaries, packages, installers, dynamic libraries,
and hidden executable content remain blocked.

Initial allowlisting is restricted to script forms with a runtime guaranteed by
the packaged macOS product. Adding another extension requires a test that proves
that runtime exists in a clean packaged environment, not merely on a developer
machine.

### Feature 2: opt-in curation report

Curation is a Host-owned, read-only analyzer invoked from an explicit Settings
action or foreground root request. Default scope includes only unchanged `user`
or `project` Skills with model-write provenance. It excludes built-in, managed,
hand-authored, pinned, changed-after-provenance, and untrusted external-project
content with a visible reason.

The deterministic report includes load/format failures, broken resource
references, exact duplicates, stale canonical tool names, and reliable unused-
Skill evidence. Semantic duplicate suggestions are labeled separately and never
treated as deterministic facts. Every row carries Skill identity, current hash,
evidence, suggested action, and confidence.

The report has no mutation command. Applying a suggestion is a separate
foreground file action that rechecks the current hash. Stale reports fail;
archive is preferred over delete; merge results are always shown before any
write. Scheduling, if ever added, consumes the same analyzer without gaining
authority.

### Dependencies and verification

Feature 1 is local to Agent authoring/provenance and may land after the final
Host composition set; it must not overlap that set's Agent Host extraction in
`main.ts`. Feature 2 includes a Settings/Host command surface and therefore also
targets the final Host transport owners. Neither depends on Source, Agent file
resources, or cross-Thread history.

Tests cover explicit versus fabricated authoring scope, all four Skill sources,
path/symlink/binary/size/secret rejection, no execution-authority gain, restart
and undo provenance, curation inclusion/exclusion, deterministic findings,
semantic suggestion separation, and stale-hash refusal. Settings work includes
light/dark and narrow-window evidence.

## Acceptance Criteria

- **AC-1:** A root-user `skillify` Turn can write one admitted textual script,
  reload the Skill without restart, and later fails to execute it when the
  ordinary process tool is unavailable or blocked.
- **AC-2:** A normal Turn, child, fabricated metadata, path escape, symlink,
  hidden/binary/oversized/secret-bearing content, built-in target, or managed
  target cannot enter the executable authoring path.
- **AC-3:** Provenance, prior-content undo, exact bundle hash, and registry
  refresh survive restart without granting additional authority.
- **AC-4:** Curation reports deterministic broken-reference, exact-duplicate,
  malformed, and stale-tool findings while semantic suggestions remain visibly
  non-deterministic and mutation-free.
- **AC-5:** Applying from a stale hash is refused, and absence of invocation
  telemetry never produces an `unused` claim.

## Open questions

- The initial executable extension set is selected by a clean packaged-runtime
  probe; unsupported interpreters stay excluded.
- Curation report persistence defaults to transient Settings state keyed by the
  registry fingerprint. Introduce bounded diagnostics persistence only if the
  implementation proves a user-visible need across restart.
- Label a Skill unused only when canonical invocation evidence exists; absence
  of telemetry is `unknown`, never `unused`.

## Implementation checklist

- [ ] Land Host composition before either Settings/Host consumer and rerun the
      live collision check.
- [ ] Ship executable support-file admission without an execution or permission
      side channel.
- [ ] Ship curation as a separate read-only report with stale-hash protection.
- [ ] Update the current Agent Skill and Settings specs per feature.
- [ ] Run typecheck, relevant Core/renderer/E2E suites, docs check, diff check,
      packaged-runtime probes where required, and visual verification.
