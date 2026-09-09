# Remove The Dedicated File Delete Tool

## Goal

Retire the dedicated file deletion tool in one complete PR. Agents delete files
and directories through the existing Bash tool, matching the Claude Code
workflow approved by the PM. Deletion follows the invoked command's semantics;
the application no longer redirects it into an Agent-owned trash directory.

## Non-goals

- No replacement deletion tool, CLI, compatibility alias, or automatic backup.
- No changes to Outline deletion, Skill lifecycle, or general Bash authority.
- No deletion or migration of existing user files or previously trashed files.
- No changes to the Settings tool retirement owned by PR #656.

## Design

Remove the tool from `MODEL_TOOL_CATALOG` and `createLocalTools`, including its
input/output schema, path classification, reserved trash destination, execution
handler, and result projection. Simplify file admission after its special
directory-entry branch has no consumer. Keep Bash deletion action descriptors,
explicit blocks, delegated access policy, execution isolation, and audit intact.

Update Bash guidance to direct file and directory removal through ordinary
commands such as `rm`, `rmdir`, and `git rm`. Remove dedicated dynamic-tool
presentation and context-reduction branches. Generic canonical file-change
deletion presentation remains because other file-change producers still use it.
The Skill curation diagnostic points retired deletion names to Bash instead of
suggesting a removed tool; it is guidance, not an execution alias.

Replace dedicated-trash tests with regression coverage for the actual replacement:
the catalog and local factory omit the retired tool, Bash deletes the requested
file/directory or symlink entry, and existing deletion blocks/read-only policy
still reject mutations. Update the catalog snapshot and owning tool spec.
Derive the retirement sweep from repository searches, allowing only explicit
retirement diagnostics/tests and historical documents to retain the old name.

### Scope And Collision

The change touches `src/core/agent/tools.ts`, local capability/admission helpers,
`PiTurnExecutor`, context reducers, dynamic tool presentation, their focused
Core/renderer tests and snapshot, and `docs/spec/agent-tool-design.md`.
No infrastructure-ownership file is required.

PR #656 overlaps on the catalog, capability module, and tool specification while
retiring twelve different Settings tools. Both changes preserve the same
registry/admission mechanism and can be reviewed independently. Declare the
overlap in this PR and verify the combined tree before handing it to the main
integration agent; main owns final merge ordering and board/archive updates.

### Verification And Risks

Run typecheck, relevant Core/renderer tests, documentation checks, and diff checks.
Exercise deletion only on disposable temporary fixtures. The intentional
behavior change is that shell deletion has no automatic Agent trash recovery;
Git or a user-selected backup command supplies recovery where needed. Removing
the tool must not weaken shell authorization or isolation.

## Open questions

None. The PM selected removal and the existing Bash workflow explicitly.
