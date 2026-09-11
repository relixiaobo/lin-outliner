# Global Memory and Agent Profile Files

## Goal

### Purpose and target user

Help the person carry useful understanding across conversations without maintaining a diary for the Agent. Stable personal context should be available when useful, while important experiences, decisions, and uncertainties retain their dates and evidence.

Provide one current authority for each kind of retained information: profile files for explicit Agent behavior and current personal context, dated Outline Nodes for valuable experiences and contextual knowledge, and canonical conversation history for original evidence. Users should benefit without maintaining a daily memory journal or reviewing routine learning proposals.

- **OBJ-1:** Reduce low-value records and repeated explanation.
- **OBJ-2:** Make stable user preferences usable without a separate memory search on every task.
- **OBJ-3:** Preserve dates, source attribution, correction, and forgetting across retained knowledge.

## Non-goals

Automation management, a second Outline runtime, project-specific memory pools, independent delegated-agent memory identities, a general knowledge graph, compulsory embeddings, background rewriting of core identity, daily output quotas, cross-device synchronization, or new Settings-management model tools. No mandatory duplication of a preference in files and Nodes, no `LEARNED.md`, and no automatic Node creation merely to give a profile entry a source link.

## Design

### Difference from the current implementation

The current implementation already has a global Memory collection as Daily Notes Nodes, source-date anchors, episode/belief/question/guidance categories, background extraction/consolidation, Outline CLI retrieval, user-edit authority, provenance, and disable/Reset/recovery controls. The prompt already allows no output when there is no durable signal. Configuration already uses files and stable prompt layers. These are retained foundations, not new benefits.

| Area | Current implementation | Selected change |
| --- | --- | --- |
| Stable user preferences | Can be retained as guidance/belief Nodes; using them normally requires Outline lookup | Extract them directly to canonical `USER.md`, with source and update controls; no intermediate preference Node or generated learned-file copy |
| Identity and style | Built-in persona plus inline configuration instructions | Explicit `IDENTITY.md` and `STYLE.md` components; capabilities remain under validated configuration |
| Memory quality | Broad durable-signal rules and required headline/episode wrappers | Stricter future-use/novelty criteria and only the meaningful Node content, without compulsory wrappers |
| Detailed memory access | `outline find` followed by bounded `outline get` | Retain this route; file-based preferences do not introduce another recall tool |
| Time | Canonical source day already retained | Preserve it; meaningful dated decision changes and current-versus-historical interpretation are refinements, not a new reason to replace storage |

Global Current/topic views, richer temporal status, shorter background scheduling, source-window fixes, and narrower Reset ownership are distinguishable supporting or additional work. They do not establish the value of profile files by themselves and should be reviewed as such. The three central changes are content routing, targeted profile customization, and better retention quality.

### Decisions, constraints, and scope

- **DEC-1:** Maintain one user-wide understanding across conversations and Agent profiles. Project associations are applicability, not memory ownership.
- **DEC-2:** `USER.md` is the canonical current user profile, including supported stable preferences and relevant stable background. It can be updated directly from eligible conversation evidence.
- **DEC-3:** Memory Nodes retain useful episodes, decisions, unresolved questions, contextual conclusions, and future guidance that is not merely a duplicate of a current user preference. Nodes remain on Daily Notes and use Outline CLI.
- **DEC-4:** `IDENTITY.md` and `STYLE.md` define explicit role and default style. Ordinary learning may refine behavior through `USER.md` without rewriting those files or changing capabilities.
- **DEC-5:** A significant experience or preference change may merit a dated Memory Node independently. Its value must come from the event, reasons, conditions, or consequences; it is not a compulsory record of every profile edit.
- **DEC-6:** Each accepted fact has one current editable authority. Source evidence and historical descriptions can be referenced without becoming competing current copies.

**CON-1 hard:** Retain the user's choice of Outline Node Memory, profile files, global ownership, and the temporal purpose of Daily Notes. **CON-2 hard:** Node commands, admission, provenance, user-edit priority, process isolation, and truthful publication/recovery remain governing constraints. **CON-3 resolvable:** Mandatory daily narrative wrappers and source-window replacement behavior may change. **CON-4 soft:** File size, scheduling, and disclosure defaults require measurement; they do not determine content ownership.

A clean-slate model still separates evidence, current personal context, and retained experiences/knowledge. The selected existing-system target reuses Nodes and configuration file tools. The accepted cost is controlled profile updates and source/lifecycle metadata; the Node-to-file projection and its mandatory synchronization are removed. A retention-only improvement remains useful on its own.

### Preserve the established memory model

The [Memory foundations](reference/agent-memory-foundations.md) remain conceptually useful. The [current Memory specification](../spec/agent-memory.md) describes current behavior until implementation changes it.

Evidence is distinct from interpretation. Episodes preserve useful event context; beliefs express supported conclusions; questions preserve consequential uncertainty; guidance describes future handling. Encoding selects new signal, consolidation integrates related knowledge, and reconsolidation permits correction. Procedures remain Skills. Source links do not turn repeated Agent prose into new independent evidence.

These categories do not require every useful fact to be a Node. A user preference is semantic knowledge whose current authority is now the profile file. Node beliefs and guidance still cover non-profile knowledge, such as why a work decision was made or a contextual lesson from an important event. A routine preference needs neither an episode nor a generated daily headline.

### Product model and routing

| Content | Canonical authority | Example |
| --- | --- | --- |
| Stable personal preference or background | `USER.md` | Preferred report structure, relevant role, a recurring collaboration constraint |
| Explicit Agent role or default working style | `IDENTITY.md` / `STYLE.md` | Research role, default degree of challenge or explanation |
| Important experienced event or decision | Memory Node | A product decision with reasons and conditions, or a costly mistake worth revisiting |
| Consequential unresolved question | Memory Node | An unresolved choice that will affect later work |
| Detailed conversation and routine progress | Original history and existing task owners | Full discussion, ordinary completion, exact quotations |
| Reusable procedure | Skill | A verified multi-step workflow |
| Runtime model, tools, permissions | Existing configuration | Actual capabilities and execution limits |

**FR-1:** Neither switching a project nor selecting another Agent profile creates a new user profile or Memory collection. Conditional preferences retain explicit scope. A project's intrinsic requirement belongs in its canonical document or contextual Memory, not in `USER.md` simply because the user mentioned it.

**FR-2:** Learning chooses a destination based on meaning before publishing. A stable preference is proposed directly to the profile owner. A valuable event or contextual conclusion is proposed to the Node Memory owner. A source can support both only when the outputs serve independently useful purposes. Merely changing `USER.md` never obliges creation of a Memory Node.

A synthetic example: an explicit ongoing request to lead research reports with conclusions updates `USER.md` with its scope and source conversation. It creates no preference Node by default. If the request followed a consequential failed handoff whose causes will matter later, a dated episode about that handoff may also be retained, with a reference to the current preference rather than another mutable statement of its current value.

### Profile files and learning contract

**FR-3:** Proposed logical files under isolated `userData` are:

```text
agent/
  config.json
  profiles/
    default/                 example selected Agent profile
      IDENTITY.md
      STYLE.md
  user/
    USER.md
```

Existing configuration owns display identity, provider/model, capabilities, and permissions. File text cannot grant runtime authority. No profile-completion form is required; the default identity/style remains available and `USER.md` can be empty.

`IDENTITY.md` and `STYLE.md` change through direct editing or an explicit request to change those components. `USER.md` is directly maintainable by the person and the Agent's eligible learning process. There is no independently writable learned-profile copy.

**FR-4:** A profile update carries an expected file/entry revision, source references, known observation/validity times, applicability, and authorship: explicit user instruction, user-authored edit, or supported learned inference. The host owns admission and authorship metadata; a model cannot assign itself user authority. Metadata can remain in the profile owner's control state while the file stays readable. Source links point directly to original conversation Items or other admissible evidence; a Memory Node is optional context, never a mandatory intermediary.

Use small separately attributable profile entries. Managed file edits and the profile editor use the same owner. When the person changes an entry, later inferred updates cannot silently overwrite it. A new explicit user correction can supersede the relevant value. Unchanged entries retain their identities and provenance. An observed external edit has honest manual-file attribution, not invented conversational support.

Validate file revisions before admitting them. Invalid or conflicting saves remain available for correction, and inspection distinguishes saved, accepted, and effective revisions. Unknown external modifications are not automatically treated as trusted model evidence. Arbitrary simultaneous writers outside the owner do not receive a lossless-editing guarantee. No recurring user approval queue is added for valid routine learning.

### Retention quality and learning

**FR-5:** Before either destination is written, require eligible identifiable support, a concrete future use, novelty or a necessary correction, appropriately narrow scope, and sufficient context to avoid a misleading conclusion. Use authorized history retrieval as the comparison: retaining a record should improve future behavior, avoid a specific error, preserve important understanding, or avoid substantial repeated synthesis.

A clear durable correction may qualify once. Repeated independent feedback may justify a narrow inferred habit. Temporary instructions, silence, task completion, repeated Agent output, generic advice, and copied search results do not establish stable user preferences. Ambiguous attribution produces no learned update. Existing documents, configuration, and Skills retain facts they already own.

**FR-6:** A no-signal or duplicate result can produce zero changes in both files and Nodes. Model proposals carry a private admission rationale, but model self-rating is not proof of usefulness. The Host validates lineage, authority, expected revisions, and lifecycle conditions; quality is evaluated on a frozen corpus.

**FR-7:** Explicit remember/correct requests are routed to the appropriate owner in the foreground. A stable preference can be saved to `USER.md` without first creating a Node. Acknowledgment follows accepted publication. Routine learning processes new eligible completed-Turn evidence in bounded coalesced batches. Extraction coverage and replacement coverage must match; unprocessed older evidence cannot lose support because the model sees only a recent window. Reconcile related existing content and avoid whole-store rewrites.

A 30-second quiet debounce and an available-batch start target of two minutes are proposed tuning defaults, not completion SLAs or measured savings. A busy or failing worker keeps a durable pending job and does not claim success. More frequent learning may increase background cost and must be measured.

**FR-8:** Direct user corrections remain eligible even when the conversation includes web/MCP content. External instructions, quotations, and recalled profile/Memory prose cannot establish user preferences by themselves. Preserve immutable enabled/disabled admission, source provenance, and excluded Thread origins. This source-aware rule is an explicit change to today's whole-Thread external-context exclusion.

### Context and access

**FR-9:** Assemble a small applicable view directly from the accepted profile files. The context is an in-memory reading of their current accepted contents, not another persisted profile authority. Retain normal Outline CLI lookup for detailed Memory: `outline find`, then bounded `outline get`. Use authorized conversation history for original evidence. No additional `recall` tool is introduced.

Start evaluation with a 2,000-token combined automatic profile ceiling, including at most 600 tokens of automatically learned entries. These are ceilings, not quotas. Explicit profile text exceeding the activation budget produces an inspection error and an editing path; it is not silently truncated. Select fewer complete learned entries when needed. Unchanged accepted files have stable ordering and bytes.

Existing authority rules remain intact: current applicable instructions and explicit user settings govern personalization; style defaults may be refined by supported preferences. Learning cannot change permissions or explicit identity. Accepted profile changes apply at the next root Turn, with recorded revisions and source eligibility, without rewriting earlier model history. Other configuration preserves its existing model/permission snapshot lifecycle.

Before profile consumers are built, demonstrate how selected `IDENTITY.md` and `STYLE.md` components compose with existing `developerInstructions`. The example contract must identify each selected component source, define instruction precedence, and cover conflicting explicit instructions and scoped user preferences. Verify an edit during an active Turn, next-eligible-root-Turn activation, unchanged frozen model/tool permissions, and explainable earlier context; do not infer source selection or precedence from file order.

### Memory Nodes and time

**FR-10 / FLOW-1: Inspect and correct.** Memory is accessed through existing Outline controls and CLI. A global Current/Timeline/topic view can reference the same dated Nodes; it does not own another copy. Direct Node edits remain authoritative. Source actions open exact available evidence or report that it is unavailable. The profile UI similarly opens `USER.md` entries with their direct sources; profile corrections do not require a Node editor.

**FR-11 / FLOW-2: Encounter dated Memory.** Keep meaningful records under their source-date Daily Notes Memory container. Use a fixed structural label and optional episode context rather than compulsory generated headlines and wrappers. An initially collapsed container preserves normal Node editing and subsequent user fold state. No useful record means no empty heading or daily page. Background changes preserve editing focus, selection, and scroll anchor.

**FR-16:** Keep source/observation time, known event time, recorded time, and known validity separate. The daily parent is a temporal navigation anchor, not the only record of time. Delayed extraction of a direct statement uses its source day; maintenance does not fabricate a new event. A genuinely new offline synthesis with no single source conversation uses its formation day and identifies its contributing evidence. Unknown boundaries stay unknown.

Profile entries also retain source and update times through their own revision/provenance control. This preserves when a preference was learned or changed without requiring a daily Node for each edit. Original conversations remain available under their retention/access contract.

**FR-17:** A meaningful contextual decision change can create a new dated Node linked to its predecessor. A typo fix or correction of a mistaken interpretation updates/retracts that interpretation rather than implying the false claim used to be true. Questions can resolve through later linked decisions. Current views use applicability and supersession, not simply the newest date. An old stable fact does not expire solely from age.

A routine profile preference change updates `USER.md` and its revision history. Create a dated Memory event only when the change or its reasons independently deserve future recall. Such historical text describes what happened then and never overrides the current profile value.

### User flows: forgetting, disabling, and recovery

**FR-12 / FLOW-3: Forget information.** Route a targeted removal to its canonical owner: a preference to the profile owner, a retained event/decision to the Memory owner. An explicit request to forget a subject across both checks both and reports partial failure truthfully. Remove affected automatic context and known-source replay eligibility so queued work does not restore the forgotten content. Preserve unrelated independently supported entries. Original conversations and independent user notes retain their own lifecycle.

Deleting an optional historical Memory event does not by itself erase an independently supported current preference in `USER.md`. Removing or correcting evidence that a learned profile entry actually relies on does trigger source-aware revalidation. Merely linking a historical event and a current preference does not create mandatory bidirectional synchronization. Source availability is distinct from evidence invalidation: ordinary source-Thread deletion or retention expiry does not by itself mean a retained preference was false or forgotten. Preserve accepted provenance and report unavailable original evidence honestly; rollback, correction, and explicit forgetting follow their own invalidation rules.

**FR-13:** The proposed Reset learned information action removes automatically learned profile entries and registered Memory records, including corrected Nodes that remain Memory. It preserves explicit identity/style, user-authored or explicitly pinned profile entries, and ordinary notes. The UI states those boundaries before its existing Reset confirmation. Keep entry provenance honest so a generated entry cannot escape Reset by labeling itself authored.

For Node Reset/targeted forget, preserve unrelated non-Memory descendants by reparenting them outside a removed Memory container in the same command transaction. Ordinary Outline Trash/delete retains its normal subtree semantics. Moving a Memory record outside its canonical classification makes it an ordinary note and withdraws that learned contribution. These Node-ownership changes are additional behavior beyond profile routing and must be reviewed explicitly.

At the core delivery boundaries, retain the existing Node Reset subtree ownership until the optional narrower Node Reset feature is implemented. Reset UI must name the actual canonical-container scope, including ordinary descendants, together with the profile entries affected by the shipped profile unit. Do not promise ordinary-descendant preservation before that behavior exists. The preservation rule above applies only to the narrower feature, and its future selection does not delay profile learning.

**FR-14:** Global disable and per-Thread modes preserve their existing timing distinctions. Ineligible Turns do not contribute automatic learning or receive automatically learned profile entries or Memory routing. Explicit authored configuration remains applicable. Existing Memory Nodes remain ordinary visible/editable content, including explicit user-supplied references. Re-enable does not admit disabled-period evidence retroactively.

**FR-15 / FLOW-4: Recover an interrupted update.** Each owner uses expected revisions, accepted content hashes, source/admission generations, and idempotent publication records. Profile content is canonical file content with immutable accepted snapshots for recovery, not a second editable collection. A successful raw file write alone is not an accepted profile update. On conflict or invalidation, omit affected learned content until it is reconciled; optional learning or inspection failure does not block ordinary conversation or Outline editing.

Profile acceptance has no hard dependency on an optional history Node publishing first. When one episode justifies both a profile update and a separate Memory event, retain idempotent pending work and truthful per-owner results. Forget/Reset coordination covers all relevant pending work before success is reported. Runtime context always validates current source eligibility and accepted revisions rather than blindly using an older on-disk or cached file.

### Acceptance criteria and validation

| ID | Trigger and expected result |
| --- | --- |
| AC-1 | Switching project/profile preserves the user-wide profile and Memory collection, with scoped applicability (FR-1) |
| AC-2 | The same Memory Node appears at its source day and in any global view, without duplicate content (FR-10, FR-11) |
| AC-3 | A stable preference updates USER.md directly and creates no Memory Node unless an independently useful event exists (FR-2, FR-5) |
| AC-4 | One-off requests, routine completion, generic advice, and duplicate signals produce no unnecessary persistent changes (FR-5, FR-6) |
| AC-5 | A clear durable preference correction is accepted by the profile owner before success is acknowledged (FR-7) |
| AC-6 | A bounded evidence update preserves support from unprocessed intervals; retries do not duplicate writes (FR-7, FR-15) |
| AC-7 | Direct corrections after web/MCP activity can be learned; external and repeated Agent prose cannot establish preferences (FR-8) |
| AC-8 | Narrow exceptions do not overwrite global preferences, identity, or capability configuration (FR-1, FR-3, FR-9) |
| AC-9 | User edits to profile entries survive later inferred updates; explicit identity/style have no ordinary learning writer (FR-3, FR-4) |
| AC-10 | Source invalidation, forgetting, Reset, and disable exclude affected automatic profile content without relying on a Memory Node mirror (FR-12 through FR-15) |
| AC-11 | Invalid, conflicting, or over-budget profile revisions are not silently activated or truncated (FR-4, FR-9) |
| AC-12 | Conflicting component/developer instructions resolve under demonstrated source and precedence rules; accepted changes affect the next eligible root Turn while model/tool permissions stay frozen and past context remains explainable (FR-9) |
| AC-13 | No useful Memory record means no daily container; actual dated records remain normal editable Nodes (FR-11) |
| AC-14 | Folding or filtering Memory does not duplicate records; background writes preserve focus, selection, and scroll (FR-10, FR-11) |
| AC-15 | User-authoritative Node edits survive background cleanup; unavailable sources are reported honestly (FR-10) |
| AC-16 | Reset removes learned entries/records and pending replay according to the shipped scope. Core-unit UI includes ordinary descendants in existing Node subtree deletion; only the optional narrower feature promises their preservation. Authored profile boundaries remain explicit (FR-12, FR-13) |
| AC-17 | Moving a Memory record out preserves its note content and withdraws that Node contribution; it does not blindly delete unrelated profile entries (FR-12, FR-13) |
| AC-18 | Re-enable does not backfill disabled-interval evidence; explicit Node references retain ordinary access (FR-14) |
| AC-19 | Interrupted file or Node publication converges to accepted revisions; optional learning failure does not block ordinary work (FR-15) |
| AC-20 | A later task can use an applicable profile preference without a preliminary Outline search or a fabricated Memory citation (FR-9) |
| AC-21 | Delayed direct Memory extraction preserves source day, distinct from event/recorded/validity time (FR-16) |
| AC-22 | Significant contextual decision changes preserve earlier dated meaning and current applicability (FR-17) |
| AC-23 | Routine profile updates preserve their source/revision times without producing daily change-log Nodes (FR-16, FR-17) |
| AC-24 | A profile and an optional historical event cannot independently dictate contradictory current preference values (FR-2, FR-9, FR-17) |

Compare history-only, current Memory, and the proposed routing with equal tasks, model conditions, and source access. Use a frozen bilingual corpus with prospective preference use, exceptions, source conflicts, temporal questions, and no-memory-needed tasks. Measure unnecessary records, missed preferences, stale use, task quality, correction freshness, loaded tokens, daily distraction, and total foreground/background cost. Deterministic authority, lineage, forgetting, and recovery cases must all pass. No measured quality or cost improvement is claimed yet.

### Implementation ownership and complete delivery units

**Shape: (b) a set of independently complete features.** Each implementation PR ships a usable behavior with its own acceptance gate. Build order inside a unit does not create separately shippable scaffolding.

| Unit | Complete result and acceptance scope | Dependency boundary |
| --- | --- | --- |
| Node retention quality | Select useful new signal, reject duplicates, preserve older unprocessed support, retain source dates, remove mandatory narrative wrappers, and preserve user edits. Covers the Node side of FR-5 through FR-7, FR-11, and FR-15; AC-4, AC-6, AC-13 through AC-15, AC-19, and AC-21. | Useful with the existing profile system. It does not depend on profile-file extraction. |
| Profile files and direct learning | Editable identity/style files, direct USER.md learning, destination routing, source-aware admission, protected edits, next-Turn context, profile forgetting/Reset/disable, and interruption recovery. Covers FR-1 through FR-9, profile inspection in FR-10, profile lifecycle in FR-12 through FR-15, and profile time semantics in FR-16/FR-17; AC-1, AC-3 through AC-12, profile portions of AC-16/AC-18/AC-19, AC-20, AC-23, and AC-24. | Complete without the Node-quality unit or additional views. Its routing must stop creating routine preference Nodes itself. It consumes existing admission, evidence, configuration, and Node mutation mechanisms. |
| Additional views, temporal decisions, or narrower Node Reset | Each is a separate optional complete feature, with its own exact scope before implementation. Relevant criteria are AC-2, view behavior in AC-14, Node ownership in AC-16/AC-17, and AC-22. | No prerequisite for the two core units. Until selected, retain existing saved search and Node Reset ownership. |

Reuse the Node command/publication owner, Memory pipeline/control store, canonical conversation evidence, configuration owners, stable-prompt composition, and existing Outline/file tools. Profile and Node learning consume one consistent evidence/admission contract rather than independently rediscovering and duplicating the same preference. One bounded extraction proposal may route to the appropriate owner; this is an implementation suggestion, not a new model-management API.

For the Node-quality unit, process complete eligible Items in oldest-first bounded
batches and journal the exact accepted origin coverage. Only accepted coverage
advances; new or duplicate evidence never replaces lineage outside that batch.
Compare proposals with a bounded canonical Memory view, retain per-statement
future-use and novelty rationales privately, and validate every cited origin before
normalization. Publish a fixed structural container with optional episodes and
complete category records. Reuse exact existing statements and add independent
support without overwriting previous text or user edits; contextual reconciliation
continues through the existing consolidation owner. No-signal batches advance
coverage without creating a Daily Note or revoking unrelated support. A failed or
oversized batch remains pending, and existing receipt recovery settles accepted
coverage exactly once. New containers use ordinary initially collapsed Outline
state and subsequent background publication does not change that state.

Expected implementation files and owners:

- `src/core/agent/configuration.ts`, `AgentConfigurationLoader`, and `AgentConfigurationWriter`: file references, accepted revisions, edit/source status, and existing root configuration boundaries.
- `src/main/agent/context/stablePrompt.ts`: bounded applicable profile context and recorded next-Turn activation; preserve model and permission snapshot ownership.
- `MemoryExtension`, `MemoryPipeline`, `MemoryControlStore`, and `TimelineMemoryStore`: destination routing, incremental source coverage, eligibility, Node publication, profile lifecycle coordination, and recovery.
- `src/renderer/ui/configuration/AgentsManager.tsx`, `src/renderer/ui/agent/AgentConfigurationEditor.tsx`, and the existing Memory UI: explicit file/source inspection, correction, and truthful pending/rejected/effective states. Reuse existing entry points; no mandatory onboarding form or candidate-approval inbox.
- Existing local file tools and `src/main/builtInSkills/configuration/SKILL.md`: preserve ordinary file editing while exposing accepted profile status through its owner; do not recreate retired Settings tools.
- `tests/core/agentMemory.test.ts`, configuration loader/writer tests, relevant renderer/E2E cases, [Agent Core](../spec/agent-core.md), [Memory](../spec/agent-memory.md), [tool design](../spec/agent-tool-design.md), and [Memory foundations](reference/agent-memory-foundations.md): verify and document the final behavior in the implementing change. Update the standing vocabulary's storage mapping so file-backed personal context does not contradict it.

Implementation shares owner surfaces with [startup fault isolation](../spec/architecture.md#desktop-host-lifecycle), [published conversation records](../spec/agent-core.md#published-conversation-records), and [targeted conversation recovery](targeted-thread-recovery.md): Memory control readiness, exact source/provenance, invalidation, publication recovery, and retained-source cleanup. Consume the current startup and record owners, refresh live claims, and settle shared file ownership before implementation. Do not write a second source resolver, startup coordinator, or recovery ledger around an interim contract. Unavailable admission authority remains a hard boundary; omitting optional learned context does not bypass it.

Consume these final mechanisms in order:

```text
startup fault isolation
  -> unified session records
  -> profile files and direct learning
  -> targeted conversation recovery
```

The profile unit consumes the settled startup admission and exact-record source contracts. Targeted recovery then consumes the profile owner's final file, admission, provenance, pending-work, and retained-source contracts rather than designing a closure against the previous Node-only ownership model. Optional views, temporal enhancements, and narrower Node Reset do not extend that prerequisite chain. Record discovery follows the current specification: non-excluded persistent roots across Profiles, including Automation roots and self, with delegated/ephemeral isolation and capability checks. Learning eligibility does not broaden that scope.

Node retention quality may ship independently using the current startup and record owners; when both core units are selected, sequence shared Memory quality changes before profile implementation to avoid rewriting those mechanisms. This is a collision order, not a functional dependency of profile learning on the quality feature. Task status and scheduling remain on the main-owned board.

Profile activation intentionally changes personalized text at a later root Turn without changing that Thread's frozen model/tool permissions. Define and test that seam before consumers. Keep imported/project instructions and repeated Agent text distinguishable from direct user evidence. A profile's source reference is not authority to broaden access to its source Thread.

For implementation, run typecheck, relevant Core/renderer tests, user-path E2E checks, docs:check, and diff checks, with UI verification where applicable. Compare the frozen corpus before claiming quality or cost improvements. Follow the pre-release format policy: affected development data resets and old-reader removal belong to the implementing change; do not add a compatibility layer. Existing user data is not mutated as part of plan review.

### Evidence and assumptions

- **EVD-1:** The selected product constraints are global dated Node Memory, file-based identity/style/user information, retention of the useful prior Memory concepts, and direct file ownership for user preferences.
- **EVD-2:** Current behavior is grounded in the [Memory specification](../spec/agent-memory.md), `MemoryExtension`, `MemoryPipeline`, `MemoryControlStore`, `agentPersonaPrompt`, and the [configuration profile contract](../spec/agent-core.md#configuration-profiles-and-presentation). Global ownership, source dates, Outline CLI retrieval, provenance, user-edit authority, and zero-output extraction are existing foundations.
- **EVD-3:** File-oriented references distinguish authored instructions, small current context, and on-demand detail. [Claude Code memory](https://code.claude.com/docs/en/memory) and [output styles](https://code.claude.com/docs/en/output-styles), [OpenClaw workspace](https://docs.openclaw.ai/concepts/agent-workspace), and the [Claude API memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) inform those distinctions. Their file layouts do not establish Tenon's storage authority or prove a performance gain. The selected hybrid preserves Outline because temporal navigation and direct Node editing are product requirements.
- **ASM-1:** Direct profile ownership removes unnecessary preference Nodes and makes stable context easier to use; verify record counts and prospective tasks.
- **ASM-2:** Stricter retention criteria reduce low-value output without discarding useful event context; verify with human-labeled examples.
- **ASM-3:** Incremental processing improves freshness at acceptable total cost; measure rather than infer savings.

## Open questions

The selected content boundary is explicit: current personal preferences in USER.md; useful dated events and contextual knowledge in Nodes; original details in conversation history. Exact metadata syntax and tuning values remain implementation design details to settle with edit/source/recovery examples. The profile file format must be demonstrated with direct edits, scoped corrections, source removal, and interrupted saves before implementation consumers are built. Additional views, temporal-state features, and Reset scope changes remain separately reviewable scope rather than prerequisites for explaining this ownership decision.
