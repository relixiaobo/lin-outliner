# Profile Files and Direct Learning

## Goal

Deliver the remaining Profile unit of [Global Memory and Agent Profile Files](archive/memory-agent-profile.md): current personal context has one editable authority in `USER.md`, explicit identity/style have their own files, and accepted applicable context reaches the next root Turn. Meaningful dated events continue through Node Memory.

## Non-goals

New model/permission policy, project-owned user profiles, profile completion forms, a learned-file mirror, mandatory preference Nodes, another recall tool, shorter passive-learning scheduling, additional Memory views, or narrower Node Reset subtree ownership.

## Design

**Shape: one complete feature in one PR.** Storage, learning, ordinary file editing, context activation, inspection/correction, forgetting/Reset and recovery ship together. Build order below describes work inside this PR.

### Files and entries

Use isolated userData:

- `agent/profiles/<profile-name>/IDENTITY.md`: explicit role, falling back to the built-in persona when absent.
- `agent/profiles/<profile-name>/STYLE.md`: explicit default working style, optional.
- `agent/user/USER.md`: one global current user profile across configuration Profiles and Projects.

Resolve component paths from the selected configuration Profile name through one validated path owner. Project developer instructions still come from the existing configuration owner; selecting a Project does not create a user profile. Files never change tools, permissions, model selection or the visible Agent name.

`USER.md` is readable Markdown with stable entry headings. For example:

```markdown
# User

## research-reports
Scope: Research reports
Lead with the conclusion, then explain the evidence and uncertainty.

## writing-language
Scope: General
Use Chinese unless another language is requested.
```

Entry keys are stable identifiers, not authority labels. Each body is a complete scoped statement. Validate duplicate/invalid keys, missing scope/body, size and secret-like content at file admission. Metadata stays private: accepted revision/hash, per-entry authorship, content hash, original Thread/Turn/Item evidence, observation time, and source invalidation. Unchanged entries retain identity and support. The file remains the canonical content; immutable accepted snapshots exist only for recovery and revision checks.

Direct human edits get honest manual-file attribution. Foreground Agent file edits are labelled as Agent edits with their owning user Turn, never silently promoted to human authorship. Automatic learning cannot overwrite those authored entries. The Agent uses ordinary file tools for an explicit requested correction; background extraction has a separate learned-write path and cannot choose its own authority. Deleting an entry records a tombstone over its known source support so queued evidence cannot restore it.

### One owner for publication and activation

A private Profile owner accepts expected-revision edits and records the exact proposed bytes and metadata before atomic file replacement. Recovery recognizes the original hash, proposed hash, or a conflicting external edit; it never blindly overwrites a concurrent revision. Report saved, accepted, pending/rejected and last-effective revisions separately. Unknown external modifications are validated and attributed honestly; they are not accepted as new conversational evidence.

Observe files through the owner before managed edits, inspection and Turn admission. Ordinary file tools route recognized Profile paths through the same publication boundary after their existing path, permission and fresh-read checks. Other writes retain normal file semantics. Raw external writers do not receive a lossless simultaneous-editing guarantee. File errors omit optional learned context and leave a repairable inspection state rather than failing the user's conversation.

### Learning and source lifecycle

Extend the existing bounded Stage 1 proposal with direct profile changes, using the same eligible Items, source labels, reader-text admission, future-use/novelty criteria and accepted evidence coverage as Node output. Send a bounded accepted-profile comparison alongside the existing Node comparison. Stable preferences/background route to the Profile owner; independently valuable events/decisions route to Nodes. Do not make a preference Node to justify a profile entry.

An unchanged independently confirmed entry extends support without rewriting its file text. A replacement must name the entry and expected revision; unrelated entries remain untouched. Learned updates require current reader-authored text. The model judges meaning, scope and whether that reader text quotes an external source; Host validation cannot establish semantic truth from provenance alone. Keep manual/explicit Agent entries protected from automatic proposals.

Journal destination work under the existing batch identity. Accept source coverage only after all proposed destinations settle. A Profile update has no dependency on an optional Node publication succeeding first: a retry reconciles accepted destination receipts without duplicating them. No-signal batches still accept coverage without publishing either destination.

Retain accepted source metadata independently of the original conversation's availability. Source deletion/retention alone does not mean a preference became false. Rollback, correction and explicit forgetting invalidate the affected support. Independent current support preserves an entry. Prepared invalidation suppresses affected automatic context until settlement; authored edits retain their independent authority.

Global/per-Thread disable continues to govern automatic learning and learned context. Explicit identity/style and authored personal context remain configuration. Disabled-period evidence is not learned retroactively. An explicit requested correction uses the accepted file-write result before reporting success; passive extraction retains its existing idle schedule.

### Context contract and precedence

Capture accepted Profile revisions once for each root Turn; ordinary edits take
effect at the next admission. Pass that admission's exact Turn ID and input to
extension context evaluation rather than rediscovering an active Turn before it
exists. Reuse the existing `additionalContext.threadState` owner: a complete
state snapshot is persisted as canonical context evidence at each input boundary,
and the projector emits only changed keyed entries or explicit revocations.
This is the existing Skill update principle (baseline, changes, checkpoint),
using the generic Thread-state mechanism rather than adding a Profile journal
or another payload kind.

Identity, style, file-routing instructions and each selected user preference
have stable keys and stable revocation scopes. A changed value explicitly
supersedes its earlier value; removing a file, entry, source support, or automatic
learning eligibility emits the existing named revocation. Preserve old canonical
messages byte-for-byte. File revisions, hashes, raw source links and observation
times remain Host inspection/provenance data and never enter model text. A new
independent confirmation therefore changes source metadata without changing
provider input. Unselected entries cannot perturb selected context through a
whole-file digest.

Keep system instructions and frozen developer configuration stable. Dynamic
Profile instructions follow them in source-labelled context on the admitted user
message. Host policy and current applicable user instructions govern; explicit
configuration developer instructions constrain selected identity/style, identity
may replace built-in persona defaults, and scoped preferences refine style.
Learning changes no tools, model or permissions. Profile text never becomes
independent reader evidence for later extraction.

Use the existing complete additional-context checkpoint during compaction:
restore only the state at the covered cursor, then apply the preserved tail.
After context clear, provide a fresh baseline. Fork and replay consume canonical
evidence; the next ordinary root admission reconciles inherited state with
current accepted files. Missing context payloads use the existing degradation
path, with a fresh complete state at the next evaluation. Unchanged state is
omitted during projection, not guessed from a side cache.

Start with the approved 2,000-token combined ceiling and 600-token learned-entry
ceiling, counting the actual keyed context rendering with the existing estimator.
Reject authored overflow with an editing path; select complete learned entries in
stable order. Source/Reset invalidation can withdraw captured learned entries at subsequent
input or provider boundaries, while ordinary edits wait for the next Turn. The
existing request-preparation lifecycle appends a complete Thread-state snapshot
only when its keyed state changes. Its latest-baseline lookup is shared with
compaction; no per-provider replay flag or Profile-only update log is introduced.
Rerun copies the original admission observation for later steering/withdrawal
checks and replays canonical evidence rather than reading newer files. Removal
withdraws current authority; it does not erase prior conversation history.

Keep cache-affinity and provider breakpoint policy with their existing owner.
Verify stable system text and unchanged earlier provider messages across Profile
updates, metadata-only confirmations, removals and restarts. Compaction legitimately rebuilds the summarized prefix while preserving cache
affinity; context clear starts a new epoch. Subsequent
updates must preserve the new prefix. Do not claim a provider cache-hit gain from
local fingerprints alone; real hit rates also depend on provider boundaries,
retention and request settings.

### Inspection, editing and Reset

Reuse Settings > Agents for identity/style/user-file editing with current source, authorship and accepted/effective state. Preserve drafts on conflicts, allow refresh and intentional retry, and expose exact available source references. Reuse existing components and feedback patterns. Configuration Skill instructions describe public files and owner-published status, with no new Settings model tool.

Extend the existing Memory Reset review with the exact learned-profile target/revision and counts. Existing canonical Node subtree ownership remains unchanged, including ordinary descendants; the dialog says so. Reset removes learned profile entries and pending replay, while preserving authored identity/style/user entries. Its existing durable journal coordinates both destinations and reports pending/partial settlement truthfully. Revalidation before admission prevents a stale review deleting later edits.

### Ownership and collision check

Primary files: new private Profile file/entry/publication owner; `Phase1`, `MemoryControlStore`, `MemoryExtension`, the existing Memory Reset target/operations; `ExtensionRegistry`, `TurnLifecycle`, generic context projection/checkpoints, and stable prompt composition; ordinary file-tool publication hooks; Host composition; Settings Agent editor and localized strings; focused Core/renderer/Electron tests; current Memory/Agent/tool specs and configuration Skill documentation.

No dependency, build, workflow, Core command protocol, task-board or changelog changes are planned. Existing schema/DTO owners may gain Profile-specific fields in their own modules. PR #682 overlaps `agentHost.ts` and `agentLocalTools.ts`: keep Profile additions to named composition/publication hooks, consume its final Task execution contracts unchanged, and resolve integration against the remote claim. Memory #685 is merged; startup and unified-record prerequisites are available. Main owns board integration and merge.

### Verification

- Demonstrate the Markdown format, independently supported confirmation, scoped correction, manual-edit protection, source-unavailable versus invalidated evidence, and forgotten-source suppression.
- Exercise expected-revision races, interrupted file replacement and destination settlement, restart recovery, and reset/disable during learning.
- Verify a root Turn uses the accepted entry without Outline search; edits affect the next Turn, preserve frozen capabilities and leave earlier diagnostics unchanged.
- Verify malformed, secret-like and over-budget content is inspectable but not activated, and optional Profile failure does not break conversation admission.
- Verify file tools and Settings use the same owner, cannot forge human authorship, and preserve drafts and unrelated content.
- Run typecheck, focused Core/renderer tests, docs/whitespace checks, build and real-Electron publication/edit/Reset scenarios. Inspect light/dark editor states. Model stubs prove deterministic contracts; do not claim live-model learning quality or cost improvements.

## Open questions

No new product decision is needed to begin the approved unit. Entry syntax and private publication metadata are reversible owner-local choices. Preserve the aggregate plan's source-availability distinction and explicit-authorship boundary in every implementation path; any requirement to change runtime authority or existing Node Reset ownership is a separate directional decision.
