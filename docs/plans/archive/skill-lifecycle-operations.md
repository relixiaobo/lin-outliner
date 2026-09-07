# Skill Lifecycle For People And Agents

## Goal

Complete the Skill lifecycle portion of
[file-first Settings](../settings-control-plane.md): a root Agent can inspect,
install, update, roll back, uninstall, and undo an Agent-authored Skill edit
through the same owners as the human Skill Library. The implementation is **one
complete feature PR**, including configuration-authority retirement, human
interaction, runtime application, and end-to-end verification.

## Non-goals

No Settings/Configuration CLI, generic setter, new Skill execution mode,
executable provisioning, private-store file workflow, or Settings-shell redesign.
No migration reader, parallel operation ledger, or new approval-policy system.
The existing `skill` invocation contract remains unchanged.

## Design

### One Source And One Lifecycle Owner

`config/settings.jsonc` alone owns `agent.skills.disabled` and explicit
`agent.skills.sources` bindings. Both local and managed toggles edit that source;
Agent toggles and bindings remain ordinary file edits. Remove the persisted
`ManagedSkillRecord.enabled`, `ManagedSkillService.setEnabled`, their IPC/client
route, and the managed-toggle queue that composes two writes. Remove Skill
writes and projections from the aggregate runtime settings DTO; keep a derived
runtime projection only where a runtime consumer needs it.

Installation records retain origin, active/previous immutable versions, and
integrity/compatibility diagnostics; the default-acquisition owner retains its
uninstall opt-outs separately. These facts are not preferences. An installed compatible, intact, unshadowed
Skill is eligible unless its identity is disabled; invocation additionally
requires the existing Skill/tool ceilings and explicit blocks. Human rows show
the configured switch separately from runtime-unavailable reasons.

Install, update, rollback, uninstall, and default acquisition do **not** edit
configuration. A fresh install is enabled by default, but an existing disabled
identity remains disabled, including across uninstall/reinstall. Remove the
Library's automatic post-install enable write. This deliberately replaces its
current re-enable behavior and avoids a cross-store transaction. Unbinding still
deletes only a pointer. Browser Pilot uninstall retains its durable acquisition
opt-out; disabling it never uninstalls or opts out.

Extend `createManagedSkillsHost` as the common lifecycle facade over the existing
`ManagedSkillService`, provenance store, and `AgentSkillRuntime`. Renderer IPC
and model tools call this facade; neither calls the other. Keep validators,
immutable content storage, and managed mutation serialization with their current
owners. Do not add a second installer or central Settings router.

### Agent Entry Points

Add two unnamespaced domain tools through `MODEL_TOOL_CATALOG` and the existing
`createAgentHost` dynamic-tool contribution. Separating inspection from mutation
lets an explicit block disable lifecycle changes without hiding diagnostics.

| Entry | Operations | Result / boundary |
| --- | --- | --- |
| `skill_inspect` | List library, inspect one target/provenance, browse catalog, discover source, check updates, preview update, read curation report | Bounded identities, versions, readiness, review data, and supported next actions; no content or preference mutation |
| `skill_manage` | Install, apply update, rollback, uninstall, undo Agent edit | One exact-target operation, owner interaction where required, and a verified outcome |
| Ordinary file tools | Enable/disable, bind/unbind; author mutable Skill content | Public configuration or governed content path, never a lifecycle index |
| `skill` | Load eligible Skill instructions | Existing invocation only; no lifecycle dispatch |

Both new tools are `rootThread` scoped. Their strict object-rooted schemas carry
a nested discriminated request, not a root union or an unconstrained payload.
Use separate `agent.skill.inspect` and `agent.skill.manage` action kinds, with
`web.fetch` on network-bearing operations and the ordinary file-write descriptor
on mutable-file undo. Derive descriptors from the selected operation so a web
block does not disable local inspection or rollback. Inspection may update owner
caches/diagnostics but never changes installed content, selected versions, or
desired availability. Explicit checks remain
unthrottled; ambient checks retain their existing policy.

Enforce tool selection, global disablement, root scope, and action blocks in the
canonical admission path and again before delayed mutation. Descendants cannot
use the operation facade indirectly. Inspection of the library is independent
of instruction invocation: disabling `skill` suppresses instruction catalogs,
loading, and slash routing, not a separately admitted inspection operation.
Update the owning specs and assembly guards together. The configuration Skill
routes jobs to these live tools without copying their schemas; a missing tool
produces an explicit limitation, never instructions to edit private files.

### Exact Targets And Human Interaction

Managed mutations bind the record identity/revision plus active hash; update
also binds the preview and candidate hash, rollback the retained previous hash.
A revision must distinguish uninstall/reinstall of the same name and bytes.
Discovery pins the repository, subdirectory, candidate, and commit. Preserve the
existing validation limits and inert installation: no Skill command runs during
acquisition. No display-name fallback or caller-supplied private path selects a
mutation target.

Mutable inspection resolves a Host-owned target in the requesting context,
including disabled and path-conditional Skills. Undo binds that identity, the
current Agent-write hash, and retained previous hash; re-resolve the physical
target and re-read provenance and bytes immediately before writing. Share a
per-target write guard with governed Skill file writes. Refuse changed ownership,
user edits, immutable content, or missing history. Undo restores only the last
definition edit, not a whole bundle or a newly created directory. This is
cooperation among Tenon writers, not an OS lock against external editors.

Agent install/apply opens the same content review as human acquisition/update;
uninstall opens the existing destructive-action confirmation. Reuse rollback
confirmation; validated single-step undo needs no additional permission prompt.
Extract the existing Skill review components into a Skill-owned native child
window so the operation does not depend on visiting a Settings category. Show
the selected source, commit, full admissible instruction body, scripts, and
update differences, including truncation limits. Render fetched content as
untrusted text, never instructions or executable HTML.

The Host binds Agent interactions to the initiating Thread/Turn/Item and human
interactions to their originating window, with an exact target/revision and a
designated review window in either case. The renderer submits only a decision to
a narrow sender-validated bridge; the model receives no redeemable confirmation
token or `approved` parameter. Revalidate target and current authority after the
interaction and inside the mutation guard. Cancellation, window/caller loss,
and timeout before commit write nothing. Do not hold a mutation lock while
waiting for the person or network. Competing interactions cannot retarget one
another; unrelated Threads keep running. No `request_user_input` authorization
flow, global drain, or resumable approval queue is introduced.

Bound the interaction by the existing 30-minute discovery/preview lifetime,
including time already elapsed. Expiry requires fresh inspection, never reuse
of a stale confirmation. Without a usable review surface, return
`interaction_unavailable` and write nothing. Both human
and Agent acquisition start this owner flow, so no second review dialog or raw
IPC commit path can bypass it.

### Bounded Results And Application

Return the canonical `TenonToolResult`, not renderer DTOs or serialized private
records. List pages default to 20 and cap at 50; cursors bind the caller's view
and snapshot fingerprint, and stale cursors require a fresh query. Keep results
within the shared byte ceiling; paginate report entries and return bounded
preview text with explicit omissions. Preserve the full admissible body for the
human review rather than treating model-output truncation as complete review.

Expected failures distinguish cancellation, stale/expired review, unavailable
resource, integrity/compatibility conflict, and denied operation. Unexpected
errors and aborts retain Kernel handling. Success identifies the committed
version/restored hash/removal, observed availability, and runtime refresh state;
an installed-but-disabled Skill is not reported as invocable. Cleanup or
notification failure after commit must not be reported as a failed mutation.
Re-read owner state to resolve uncertainty; never replay an unknown install or
destructive operation automatically, and never infer historical completion from
a coincidentally matching current hash.

Use the existing registry invalidation and canonical catalog-delta path for
primary and active Turn runtimes, with refreshed provenance after undo. The next
resolution/provider boundary observes changed content under its existing
ceiling; no existing instruction/history Item is rewritten and no new tool is
injected into an admitted Turn. A failed refresh is reported separately from
saved content. Emit a narrow Skill-library change event for open human views;
preserve the refresh/mutation ordering guarantees established by #643.

### Implementation Scope And Risks

- Contracts: new Skill operation types/schemas, `src/core/agent/tools.ts`,
  `src/core/commands.ts`, and the affected Skill DTOs in `src/core/types.ts`.
- Owners: `managedSkillService`, `managedSkillStore`, `managedSkillsHost`,
  `agentHost`, `agentSkills`, `agentSkillProvenanceStore`, the governed file-write
  path in `agentLocalTools`, and Skill settings projections in `agentSettings`.
- Adapters: domain tool factory, `desktopHost`, `windowApplicationHost`, narrow
  preload/types/client bridge, renderer entry routing, Skill review components,
  `useManagedSkills`, `SettingsSkillLibrarySection`, and `AgentSettingsView`.
- Guidance/specs: configuration Skill; `agent-skills`, `agent-tool-design`,
  `agent-tool-permissions`, and `agent-integration`; affected i18n and tests.

The managed index format changes. Follow the pre-release explicit reset policy:
delete the old decoder, test fresh isolated userData, document reinstall impact,
and coordinate the affected development-store reset before running the new
format. Do not silently add a migration or reset unrelated/prod stores.

Collision self-check: no open PR claims at drafting; the board leaves this Skill
work eligible. The approved workbench design is not an implementation claim, but
its next execution-context change may overlap `agentHost`, `desktopHost`,
`agentLocalTools`, tool contracts, and Agent specs. Recheck before claiming and
order real shared-file changes; use admitted target context without introducing
a new Thread-cwd or project-binding authority. Protected `commands.ts`/`types.ts`
edits require explicit PM approval and interface-first integration coordination.
No runtime implementation starts on an unconfirmed shared contract.

## Open questions

None. The two domain tools, file-only availability, and preservation of explicit
disabled identities during installation are the selected contract.

## Acceptance

- [ ] A provider-driven root Turn calls the real tools through
  `ToolRuntime`/Kernel, completes discover/install/inspect/update/rollback/
  uninstall and governed-edit/undo using deterministic remote fixtures and the
  real stores, and records canonical outcomes. A separate Electron run verifies
  the actual human review and narrow bridge, not an IPC-only mock.
- [ ] Each operation is tested absent, disabled, explicitly blocked, and from a
  delegated caller; forged/replayed/cross-window decisions and authority changes
  during review write nothing. Cover cancel, timeout, caller/Host loss, and
  competing reviews without blocking unrelated work.
- [ ] Preserve stale-preview, same-hash reinstall, offline update, local edit,
  integrity, default opt-out, and recovery coverage from the existing managed
  service/runtime/provenance tests. Add cross-runtime undo/write races, queued
  UI refreshes, post-commit notification failure, and list-cursor invalidation.
- [ ] File/UI/Agent tests prove one enabled source for every Skill source,
  disabled reinstall preservation, exact binding modes/path spelling, immutable
  managed content, disabled-Skill shell-environment exclusion, live
  registry/provenance refresh, and unchanged history.
  Guards find no managed enable writer, aggregate Skill settings writer,
  Settings CLI, or lifecycle path that bypasses its owner.
- [ ] Human empty/error/busy/review/cancel states pass renderer and light/dark
  E2E checks. Run typecheck, relevant Core/renderer/E2E suites, `docs:check`, and
  `git diff --check`; fold the design into its owning specs in the implementation
  PR. Main owns the board and archive gate; no Unit D completion claim precedes
  the complete ledger evidence.
