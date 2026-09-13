# Release Compatibility Enforcement

## Goal

Make release publication depend on populated compatibility and restoration
evidence for supported data. Use the local lifecycle and fixture driver defined
by the [current data lifecycle contract](../spec/data-lifecycle.md).

**Shape:** one complete feature in one PR. This is the independent release
automation feature from the [foundation design](archive/data-compatibility-foundation.md).

## Non-goals

- Reimplementing local backup, restore, migration admission or execution fences.
- Adding a fake schema change to demonstrate migration scaffolding.
- Implementing synchronization transport, accounts, external backups or shared
  execution authority.
- Replacing unsupported fixtures with empty data or resetting supported data.

## Design

Integrate `scripts/check-data-lifecycle.ts` with the main-owned release workflow
and release checklist. Preserve one immutable populated fixture per supported
release, recording its exact application revision, dirty-tree state, lockfile
and runtime/library versions, and semantic expectations. Development fixtures
remain identified as development evidence.

Exercise every supported direct upgrade path with the target build, then verify
backup and restoration through production owners. Assert retained Outline and
conversation identity, canonical content, provenance, Projects, Profile, Memory,
Task and schedule receipts, Delegation, resources and attachment bytes. Preserve
historical execution fences after restoration. Each actual domain schema change
continues to include its own migration/reader and populated source fixtures in
the feature that changes the format.

Use the existing failure and restore checks as the publication preflight. A
missing fixture, unsupported source without a defined compatibility path, or
failed semantic/restore check prevents publication. Publish the compatibility
matrix, exact runtime/library provenance and verification reports as release
artifacts. Main owns changes to `.github/workflows/release.yml` and related
release configuration; the version/tag and release-note rules remain in
[AGENTS.md](../../AGENTS.md).

The same fixture driver is a mandatory manual release check until automated
enforcement is available. Preserve source fixtures independently of temporary
working copies; failed checks retain their diagnostics and never alter the
immutable fixture.

## Open questions

- Which tagged train establishes the baseline? Use the first release containing
  the complete local lifecycle, ratified at release freeze.
- Which published sources remain supported? The foundation recommends every
  release from the baseline; shortening that window requires an explicit
  bridge/export policy.
- Where will immutable release fixtures be retained and retrieved by the release
  workflow, with suitable access and retention for their synthetic data?

## Acceptance criteria

- **AC-R1:** Upgrade populated fixtures from every supported source release and
  verify Threads, Outline, Profile, Memory, Tasks, schedules, Delegation,
  Projects, resources, attachments and recovery evidence.
- **AC-R2:** Every actual schema change carries its migration/reader, source
  fixture, semantic expectations and relevant failure/restore checks together.
- **AC-R3:** CI runs the existing driver, publishes exact runtime/library
  provenance and prevents publication when coverage or restore evidence fails.
