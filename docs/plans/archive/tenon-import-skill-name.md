# Tenon Import Skill Name

## Goal

Ship one complete feature in one PR: rename the canonical built-in Skill from
`data-cleanup` to `tenon-import` so its identity states that the cleanup and
import workflow belongs to Tenon. Present it as **Tenon Data Cleanup and
Import**, while keeping the existing `tenon-import` CLI and import behavior.

## Non-goals

- No change to source profiling, normalization, validation, preview, coverage,
  Import Pack, or commit behavior.
- No rename of the `tenon-import` CLI, import API, service, socket, descriptor,
  capability classification, or operation metadata.
- No compatibility alias for `/data-cleanup` and no migration of persisted
  disabled-Skill settings. This is a pre-release canonical-identity clean cut.
- No rewrite of historical plans, task records, changelog entries, or recorded
  Thread evidence that correctly names the old Skill at the time it ran.

## Design

### Canonical identity and authored presentation

Rename `src/main/builtInSkills/data-cleanup/` to
`src/main/builtInSkills/tenon-import/`. Because a Skill directory name is its
canonical identity, catalog and slash invocation change from `data-cleanup` to
`tenon-import`. Change the authored heading to **Tenon Data Cleanup and Import**
and describe the workflow as Tenon-owned rather than as a general-purpose data
cleanup capability. Keep its broad source coverage and existing trigger terms.

### Runtime and packaging paths

Update the development and packaged resource lookup in
`src/main/tenonImportRuntime.ts` and the import CLI build input in
`package.json`. The generated Skill sync already replaces its output root on
every run, so the packaged floor contains only `tenon-import` after the source
directory rename. The separately bundled CLI resource remains named
`tenon-import`.

### Identity transition

Do not translate `data-cleanup` to `tenon-import`. A live catalog observes the
old identity being removed and the new identity being added. A persisted
`data-cleanup` disabled setting does not disable `tenon-import`; users may
disable the new canonical identity normally. Existing Thread history remains
self-contained because replay restores recorded catalog and invocation payloads
instead of consulting current Skill files.

### Specification and verification

Update `docs/spec/agent-skills.md` to name `tenon-import` as the packaged
platform-floor Skill. Update core tests to assert the new catalog identity,
resource path, authored title, and generated packaged directory. Keep adapter
and CLI assertions behavior-focused while renaming test-local paths and labels.

Verification covers type checking, the core suite, documentation guards,
built-in Skill resource synchronization, the import CLI build, and the packaged
application build.

### Files

- `src/main/builtInSkills/tenon-import/**` (renamed from `data-cleanup/**`)
- `src/main/tenonImportRuntime.ts`
- `package.json`
- `tests/core/agentSkills.test.ts`
- `tests/core/builtInSkillScripts.test.ts`
- `tests/core/tenonImportRuntime.test.ts`
- `docs/spec/agent-skills.md`
- `docs/plans/nodex-parity-decisions.md`

`package.json` is an infrastructure-ownership file, so this remains an isolated
single-purpose PR. The collision check found no overlap with open PR #472.

## Open Questions

None. The PM approved `tenon-import` as the canonical identity, the full title,
and the clean-cut boundary without an alias or settings migration.
