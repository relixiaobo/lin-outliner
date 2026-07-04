# Data Import CLI/API Boundary

## Goal

Move data import from a model-visible `data_import` tool to a Tenon-owned
Import Pack CLI/API workflow.

The clean target is:

```text
/data-cleanup skill
  -> bash runs tenon-import
      -> inspect / convert / validate / preview Import Pack v1
      -> commit calls the running Tenon main process
          -> main process performs the document transaction
```

Import Pack stays the stable interchange format. `tenon-import` becomes the
reusable local interface for the built-in skill, future agents, and local
services. The Tenon main process remains the only authority that mutates the
outliner document.

## Non-goals

- Do not let bash, scripts, or external services write Tenon's persisted
  document state directly.
- Do not expose `data_import` as a default model tool after this plan ships.
- Do not add new source adapters beyond the existing Tana route in this PR.
- Do not build a remote/network import service. v1 is local-only.
- Do not build a user-facing import wizard. The UX remains the `/data-cleanup`
  skill workflow plus command output.
- Do not change the Import Pack v1 data model except where needed to decouple it
  from the current `pack_file` tool input.
- Do not loosen local file, skill, or outliner mutation permission boundaries.

## Shape

This plan is shape (a): one complete feature in one PR.

It should land as one complete workflow because the pieces only become clean
together: the CLI must exist, commit must still go through main, `/data-cleanup`
must use the CLI, and the model-visible `data_import` tool must be removed from
the default catalog.

## Objective, Constraints, And Options

- **OBJ-1:** Make data import a reusable Tenon capability without polluting the
  default model tool surface or letting scripts bypass document invariants.
- **Minimum acceptable outcome:** `/data-cleanup` can import through a CLI-driven
  workflow, ordinary agent runs no longer see `data_import`, and the final
  commit still produces one verified outliner transaction with undo/history/index
  integrity.
- **Clean-slate best answer:** Import Pack is a public local protocol, import
  preview/commit are app APIs, and all clients use the same CLI/API boundary.
- **Selected target:** OPT-2 because it preserves Tenon's current Import Pack and
  materializer work while moving the public surface from a model tool to a
  reusable CLI/API.

### Constraints

- **CON-1 hard:** Document mutation must stay inside Electron main / core
  command infrastructure. Direct file/database writes from bash are not allowed.
- **CON-2 hard:** Import commit must preserve one logical undo step, operation
  history metadata, search-index refresh, and post-import verification.
- **CON-3 hard:** The default model tool list should not include low-frequency
  import-specific tools.
- **CON-4 legacy:** Existing `/data-cleanup` scripts already emit Import Pack v1
  and coverage sidecars, and `agentDataImportTool.ts` already owns validation,
  dry-run preview ids, materialization, and verification.
- **CON-5 resolvable:** The current scripts are separate Bun entrypoints. This
  PR can keep wrappers, but should provide one canonical `tenon-import` CLI
  shape for the skill and future clients.
- **CON-6 unknown:** The final packaged CLI runtime shape may need adjustment
  because packaged Tenon cannot assume a user-installed Bun. The dev must verify
  the packaged invocation path rather than relying only on source tests.

### Options

- **OPT-1 clean-slate:** Build a local Import API first, then make every adapter,
  CLI, and service client call it.
  - **Rejected for now:** Too much platform work if it also requires a full
    external-service auth story and installed CLI distribution.
- **OPT-2 brownfield target:** Extract the existing `data_import` implementation
  into an internal import service, add a local `tenon-import` CLI/API client,
  update `/data-cleanup` to use it, and remove `data_import` from the model tool
  catalog.
  - **Tradeoff TRD-1:** The first CLI may be app-local rather than a globally
    installed command, but the protocol and subcommands become stable.
- **OPT-3 minimum acceptable:** Hide `data_import` except for `/data-cleanup`
  profile injection.
  - **Rejected for this plan:** It improves caching/tool surface but does not
    create the reusable CLI/API boundary for future agents and services.

## Design

### Product Model

- **Import Pack v1:** The stable data interchange artifact. Source adapters and
  external clients produce it; it is not document state.
- **`tenon-import` CLI:** The command-line interface used by `/data-cleanup`,
  humans, and future local agents/services.
- **Import service:** The main-process application service that validates,
  previews, commits, audits, and verifies import packs.
- **Commit primitive:** Internal only. It replaces the model-facing
  `data_import` tool as the final write path.

### CLI Surface

Provide one canonical CLI with subcommands:

```bash
tenon-import inspect <source> --out <profile.json>
tenon-import tana <tana-export.json> --out <pack.json> --coverage-out <coverage.json> [--fidelity content|clean|full]
tenon-import validate <pack.json> [--out <report.json>]
tenon-import preview <pack.json> --out <preview.md> [--parent-id <node-id>] [--json]
tenon-import commit <pack.json> --preview-id <preview:id> [--parent-id <node-id>] [--json]
```

Existing scripts may remain as compatibility wrappers, but the skill should use
the canonical `tenon-import` commands.

`preview` should validate and render a human-readable preview. It should also
ask the running Tenon import service for a dry-run preview id when the app API is
available. If the app is unavailable, `preview` should fail with a structured
`app_unavailable` error unless an explicit offline-preview mode is provided.

`commit` must be API-backed only. It must never write Tenon storage directly.

### Local Import API

The import API is local-only and app-owned. The exact transport may be a Unix
domain socket, localhost JSON-RPC endpoint, or equivalent Electron main-process
bridge, but it must satisfy these rules:

- It is reachable by `tenon-import` while the app is running.
- It is not exposed as a remote unauthenticated network service.
- It accepts bounded Import Pack JSON content or a staged app-owned pack
  reference, not an arbitrary filesystem path that bypasses file-read policy.
- It returns structured JSON for success and error states.
- It revalidates the pack at preview and commit time.
- Commit requires a preview id whose pack hash, destination, and mode match the
  current request.
- Preview ids are single-use and expire.

The main-process service should be factored so agent/tool tests and CLI/API
tests exercise the same validation/materialization implementation.

### Commit Semantics

Commit through the import service must preserve the existing guarantees:

- one explicit staging root under the selected destination;
- section headings and imported nodes below that root;
- one logical agent/system operation in undo and operation history;
- yield-aware materialization for large packs;
- search-index refreshes remain chunked/cooperative;
- post-import verification compares sections, nodes, descriptions, tags, fields,
  and checked counts;
- verification mismatch returns a structured failure with created ids and
  recovery instructions.

### Model Tool Surface

After this plan ships:

- `data_import` is not returned by `createAgentTools` for ordinary runs.
- `/data-cleanup` frontmatter no longer lists `data_import` in `allowed-tools`.
- The skill uses `bash` to run `tenon-import`.
- Tool docs describe Import Pack CLI/API, not a model-visible `data_import`
  function.
- Permission docs no longer treat `data_import` as a public model tool. They
  should describe `tenon-import commit` / import API commit as an `outline.edit`
  consequence.

The internal code may keep a `data_import`-named module temporarily only if it is
renamed or clearly scoped as an internal import service before the PR is marked
ready.

### Skill Workflow

Update `/data-cleanup` to describe this workflow:

1. Inspect the source with `tenon-import inspect`.
2. Convert known formats with a deterministic subcommand such as
   `tenon-import tana`.
3. Validate the pack with `tenon-import validate`.
4. Preview with `tenon-import preview`.
5. Show stats, coverage, warnings, representative samples, and preview id to the
   user.
6. Ask the user whether to commit.
7. Commit with `tenon-import commit --preview-id ...`.
8. Report the staging root and verification result.

The model coordinates and explains choices; it does not parse large exports
record-by-record.

### Permission And Audit

`tenon-import preview` is read/validation behavior. `tenon-import commit` is an
outliner mutation and should be audited as `outline.edit`.

The dev should choose the narrowest implementation that fits the current
permission system:

- If command-level bash permission classification is sufficient, classify
  `tenon-import commit` as an outline edit consequence.
- If not, enforce the write boundary inside the import API and record the commit
  origin as `tenon-import` with the current conversation/run metadata when
  available.

Either way, a commit must be visible in operation history and undoable as one
import operation.

### Packaging And Runtime

The CLI must work in both dev and packaged builds:

- Development can execute source scripts.
- Packaged Tenon must include the CLI or compiled script resources needed by
  `/data-cleanup`.
- The skill must refer to a stable app-local path or helper, not a user's random
  shell `PATH`.
- The implementation must not require Homebrew/Bun to be installed by the user
  for the packaged import workflow unless that dependency is explicitly kept and
  documented as a remaining limitation.

### Spec Sync

Update the current specs in the same PR:

- `docs/spec/agent-tool-design.md`: replace the `data_import` tool section with
  the Import Pack CLI/API contract.
- `docs/spec/agent-skills.md`: `/data-cleanup` uses `tenon-import`, not the
  model-visible `data_import` tool.
- `docs/spec/agent-tool-permissions.md`: remove public `data_import` permission
  guidance and document import commit as an `outline.edit` consequence.
- Any built-in skill references under
  `src/main/builtInSkills/data-cleanup/references/` should use the CLI/API
  terminology.

## Requirements And Acceptance Criteria

- **FR-1:** The default agent tool catalog does not expose `data_import`.
  - **AC-1:** When `createAgentTools` is called for an ordinary run, the returned
    tool names shall not include `data_import`.
- **FR-2:** `/data-cleanup` can complete a Tana import through `tenon-import`
  without a model-visible import tool.
  - **AC-2:** The skill instructions and allowed-tools frontmatter shall use
    `bash` + `tenon-import` for import work and shall not list `data_import`.
- **FR-3:** `tenon-import preview` validates the pack and returns a preview id
  produced by the main-process import service.
  - **AC-3:** If the app import API is unavailable, preview shall fail with a
    structured app-unavailable error unless explicitly run in offline-preview
    mode.
- **FR-4:** `tenon-import commit` writes only through the main-process import
  service.
  - **AC-4:** Tests shall prove commit does not write document storage directly
    and still records one undoable operation-history entry.
- **FR-5:** The import service preserves existing dry-run, hash match,
  single-use preview id, TTL, validation, materialization, and verification
  behavior.
  - **AC-5:** Existing `agentDataImportTool` coverage is preserved or migrated
    to import-service/CLI tests with equivalent assertions.
- **FR-6:** Import Pack remains reusable by future agents and services.
  - **AC-6:** The CLI/API accepts a standard Import Pack and produces structured
    JSON output that another local process can consume without model-specific
    tool envelopes.
- **NFR-1:** Default prompt/tool cache should improve or stay stable because the
  low-frequency import tool is removed from the default tool schema.
  - **AC-7:** A test or snapshot shall assert the default tool names exclude
    `data_import`; docs shall state import is CLI/API-scoped.
- **NFR-2:** Packaged behavior is verified.
  - **AC-8:** `bun run app:build` or an equivalent packaging/resource check shall
    prove the packaged `/data-cleanup` workflow can locate the CLI resources.

## Suggested Implementation Boundaries

- `src/main/agentDataImportTool.ts` should be split or renamed into an internal
  import service plus any thin legacy adapter needed during the PR.
- `src/main/agentTools.ts` should stop adding `createDataImportTool` to the
  public catalog.
- `src/main/builtInSkills/data-cleanup/` should get the canonical CLI entrypoint
  and updated skill docs.
- `tests/core/agentDataImportTool.test.ts` should become import-service and CLI
  tests, or be replaced by equivalent coverage.
- Permission tests should stop asserting public `data_import` behavior and add
  coverage for the new import commit boundary.

## Risks

- **RISK-1:** A CLI that depends on user-installed Bun would make packaged import
  brittle. Verify the packaged invocation path before marking the PR ready.
- **RISK-2:** A local API that accepts arbitrary paths could bypass file-read
  jailing. Prefer passing bounded pack content or an app-staged pack reference.
- **RISK-3:** Removing the model tool without updating `/data-cleanup` would
  strand the workflow. The PR must update the skill and tests together.
- **RISK-4:** Permission semantics can become less visible if commit is hidden
  inside bash. The import service must audit the commit clearly, and tests must
  prove operation-history visibility.

## Open Questions

- **OQ-1:** Which local transport should v1 use: Unix domain socket, localhost
  JSON-RPC with a local token, or another Electron main-process bridge?
  - Recommended default: choose the smallest local-only transport that supports
    request/response JSON, packaged builds, and future local service clients.
- **OQ-2:** Should packaged Tenon include a standalone compiled CLI, or should
  the CLI run as an app-local Electron/Bun script?
  - This is implementation-sensitive; the acceptance criterion is packaged
    reliability, not a specific runtime.

## Implementation Tasks

- [ ] 1. Extract the current import implementation into an internal import
  service.
  - Covers FR-4, FR-5.
  - Acceptance: AC-4, AC-5.
  - Verification: migrated dry-run/commit/verification tests pass.

- [ ] 2. Add the local Import API transport and structured request/response
  schema.
  - Covers FR-3, FR-4, FR-6.
  - Acceptance: AC-3, AC-4, AC-6.
  - Verification: API tests for preview, commit, app unavailable, preview
    mismatch, preview expiration, and malformed pack.

- [ ] 3. Add the canonical `tenon-import` CLI and keep or convert existing
  scripts as subcommands/wrappers.
  - Covers FR-2, FR-3, FR-6, NFR-2.
  - Acceptance: AC-2, AC-3, AC-6, AC-8.
  - Verification: CLI tests for inspect, Tana conversion, validate, preview, and
    commit against a test import service.

- [ ] 4. Update `/data-cleanup` to use the CLI and remove `data_import` from its
  frontmatter.
  - Covers FR-2.
  - Acceptance: AC-2.
  - Verification: built-in skill tests assert the frontmatter and workflow text.

- [ ] 5. Remove `data_import` from the default model-visible tool catalog and
  update permission/action-kind references.
  - Covers FR-1, NFR-1.
  - Acceptance: AC-1, AC-7.
  - Verification: default tool catalog tests and permission-model tests.

- [ ] 6. Sync specs and references.
  - Covers all requirements.
  - Verification: `bun run docs:check`.

- [ ] 7. Run final validation.
  - Covers AC-8 and regression safety.
  - Verification: `bun run typecheck`, relevant core tests, `bun run docs:check`,
    and packaged CLI/resource verification via `bun run app:build` or an
    equivalent resource check.
