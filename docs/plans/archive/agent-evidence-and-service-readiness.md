# Agent Image Evidence and Service Readiness

## Goal and reader

Give a person reliable image understanding and truthful application-launch
results when using the Agent to inspect screenshots or run local services.

**OBJ-1:** Model observations retain the uploaded image's actual visual content.
**OBJ-2:** Service handoff uses real, authorized evidence without treating cwd
equality as proof of service identity. **OBJ-3:** The Agent distinguishes a
running process, a usable application, and an unresolved startup failure.

Minimum acceptable outcome: a managed screenshot remains recognizable at the
provider boundary; valid checks survive directory differences; a frontend-only
success cannot justify claiming that a failed document runtime is usable.

## Non-goals

- A new health-check tool, verification registry, evidence store, process owner,
  working-directory resolver, or scheduling/recovery coordinator.
- Parsing shell `cd` to infer Host context; broadening permissions, network
  bindings, image budgets, or accepted Skill contracts.
- Automatic restart, data reset, historical image rewriting, migrations,
  proactive diagnostic badges, or retry-group/recovery state in the transcript.
- Claiming the original Outline Runtime timeout is fixed without identifying
  its cause. That investigation is bounded separately below.

## Design

### Decision, constraints, and evidence

**Shape: (b) A SET of two independent complete features.** Unit A fixes image
observation end to end. Unit B fixes service-evidence acceptance and its native
verification workflow together. Each has its own complete PR and acceptance;
neither is infrastructure waiting for a later consumer to become useful.

**CON-1:** Preserve current Thread/Task ownership, command admission, isolation,
immutable resource provenance, and process/renderer boundaries. **CON-2:** Use
the existing resource and Task contracts; the target needs no persisted format
change, additional model tool, dependency, or infrastructure-ownership edit.

**EVD-1:** The dev-session audit found two Threads, four Turns, 40 tool calls,
six handoff rejections and three command failures. All six rejected handoffs
referenced successful, post-launch checks whose cwd differed from the service.
**EVD-2:** A valid PNG stored under `.blob` was decoded successfully, but
`prepareBoundedAgentImageUnlocked` replaced it with an OS thumbnail. An isolated
Electron reproduction generated the exact bytes of the retained document icon.
**EVD-3:** Initial service stderr and the original screenshot both show Outline
Runtime startup timeout, despite a successful frontend HTTP check and handoff.
**EVD-4:** The replacement service listened on IPv6 loopback; the failed check
substituted IPv4. A later read-only probe reproduced that refusal while IPv6
succeeded. The original data was already removed during the authorized reset;
update and reset happened together, so neither establishes the timeout's cause.

**DEC-1:** Decode source pixels through one bounded image normalizer. A file
extension or OS document preview cannot determine model-visible image content.
**DEC-2:** The existing `task_control` request already binds `task_id` to exact
`readiness` Item references. Keep that association rather than adding a second
target field or check-task relationship. Remove cwd equality as an eligibility
condition while retaining each check's independently admitted execution facts.
**DEC-3:** Host validation proves identity, authority, ordering and successful
completion; the Agent verifies whether those observations establish the user's
requested application behavior. A handoff receipt is not Host certification of
arbitrary command/output meaning. Same-directory commands cannot supply that
certification either.

The selected target repairs these existing boundaries directly. Error-copy-only
changes leave both defects intact. Requiring an inherited service cwd for every
check breaks legitimate cross-directory checks and default-folder changes.
A universal application-health framework would add a competing authority with
no evidence that these incidents require it. **TRD-1:** Semantic sufficiency
remains Agent judgment, tested with actual Agent acceptance runs as well as
deterministic Host fixtures; prompts alone do not provide a mechanical guarantee.

### Unit A: image requirements and flow

**FR-1:** Attachment images, `file_read` image observations, and generated/tool
output images use one pixel-decoding, bounded-resize and encoding mechanism.
Path acquisition and resource authorization remain with their current owners;
they feed that mechanism without invoking `createThumbnailFromPath`. UI-only
file previews and OS thumbnails are outside this replacement.

Decode once, preserve supported-format behavior and canonical pixel orientation,
preserve aspect ratio without upscaling, and retain transparency where the
existing output encoding supports it. Keep `MAX_IMAGE_ATTACHMENT_SOURCE_BYTES`,
`MAX_PROMPT_IMAGE_BYTES`, `MAX_PROMPT_IMAGE_DIMENSION`, aggregate limits and the
existing serialization/cancellation boundary. Do not gain image fidelity by
dropping decode or memory bounds. Corrupt/unavailable inputs follow the existing
admission or per-output failure path; a nonempty file icon is never a fallback.

**FR-2:** Derive geometry from the actual decoded source and final observation.
Persist and project that exact observation once. Preserve original resources,
original-first export/edit resolution, and source/observation retention. Existing
historical observations remain immutable evidence of what the model saw; an
explicit new read can create a corrected new observation from an available
original. Do not silently repair history or reset userData.

**FLOW-1:** Upload or read an authorized image, normalize its pixels, persist the
original/observation through the existing owner, and send the observation at the
provider boundary. Decode failure is explicit and retains the current draft or
output failure behavior instead of supplying unrelated visual content.

Implementation scope: image helpers and Host wiring in `desktopHost`, a private
shared normalizer if extraction makes ownership clearer, `AttachmentResolver`,
image-reading/output integration only where needed, and focused tests. Keep
`ThreadImageArtifactReference` and resource storage shapes unchanged. Fold the
pixel/geometry invariant into Agent Core and tool-design specifications.

### Unit B: service requirements and flows

**FR-3:** `ThreadService.validateTaskReadiness` validates exact owner provenance,
eligible completed Item type, successful command/tool result, and ordering after
the addressed launch. Task-backed checks retain their actual successful Task
state and start ordering. Reject missing, copied/foreign, incomplete, failed,
pre-launch, launch-self, `task_status` and `task_control` evidence. Different cwd
alone is neither rejection nor permission. A check's independent capability,
worktree and process admission must remain intact; referencing it cannot rerun
it, borrow the service's access, or redirect either process.

The active-root caller, target service liveness, revision, receipt replay, Stop,
watch and event-disposition rules remain with `ToolTaskService`/`ToolTaskStore`.
A service replaced or stopped after a check cannot acquire a fresh handoff from
stale evidence. Identical accepted-operation replay retains its original meaning.
Do not add a new Task relationship, compatibility reader or durable receipt type.

**FR-4:** Expected evidence rejections use `AgentToolFailure` and the existing
error envelope's code, bounded message and recovery instructions. Distinguish
unavailable reference, ineligible source/type, unfinished/failed check and
pre-launch evidence; identify the offending Item only within the owning Thread.
Do not convert persistence faults into validation errors or fabricate success.
Existing transcript details display the returned reason; cosmetic grouping and
new lifecycle labels are not required for this feature.

**FR-5:** The built-in development Skill teaches one complete launch workflow:

1. Read the applicable instructions and launch with the intended explicit cwd.
   A shell `cd` does not change the Host's admitted directory. Keep the Task ID
   and actual context; use the current directory owner, including the accepted
   conversation default when available.
2. Inspect bounded launch observations and choose a check of the application
   behavior the person requested. Use its native readiness/status interface or
   an authorized application interaction. For Tenon, verify the intended Runtime
   and workspace through existing interfaces; a Vite response alone is partial.
   Address the target application's exact isolated root rather than the Agent
   Host's default Runtime. Inspection must not implicitly start or repair it;
   use the existing no-start inspection behavior. A different healthy clone
   cannot supply the target application's readiness evidence.
3. Use the actual advertised endpoint and validate both transport and application
   result. Preserve hostname/address family; do not broaden listeners or guess
   that an IPv4 refusal proves a service crash. Bound checks without blind sleeps
   or unchanged retries. Never parse command names to select responsibility.
4. Hand off the exact running service only after sufficient successful checks.
   Otherwise report the observed launch limitation and retain its current
   responsibility. New repair/reset/restart still requires existing task scope.
5. For an explicitly authorized reset, retain available failure evidence first,
   stop the exact target through its owner, honor managed content permissions,
   and verify absence with an absence check rather than listing a deleted path.
   No new reset command or broad filesystem permission change is introduced.

**FLOW-2:** Launch from A, optionally change the conversation default to B, run
an independently authorized check of the service still running in A, and submit
its Item reference with that service's Task ID. A valid result may hand off;
failed evidence or a terminal/replaced target cannot. The saved default and both
actual execution addresses remain unchanged by the handoff.

**FLOW-3:** A frontend responds while the document runtime fails. The Agent
reports partial startup and the actual runtime error, preserves evidence, and
does not claim workspace availability. An explicitly authorized later repair
must pass the same application check; successful deletion or HTTP response is
not proof of repair.

Implementation scope: `ThreadService` evidence validation, expected-failure
mapping through `ToolRuntime`, the development Skill and its existing tool/prompt
guidance where contradictory, plus Task/Thread and Electron fixtures. Reuse the
existing error envelope and `TaskItemReference`; no input/storage schema change
is planned. Fold authority and verification wording into tool design and Agent
integration specifications in the same PR.

### Acceptance criteria and failure verification

- **AC-1 (FR-1/2):** When the same asymmetric marked PNG is admitted under `.png`,
  `.blob` and no extension through real Electron, each shall yield the same
  recognizable pixels and correct geometry at the provider boundary. Exercise
  actual resource upload/admission, not only a mocked normalizer.
- **AC-2 (FR-1/2):** When reading large images, transparent PNGs, oriented JPEGs
  and tool image outputs, the result shall preserve content/orientation and
  current limits; corrupt, oversized and cancelled inputs shall retain explicit
  failure behavior. Original export and immutable replay survive reopening.
- **AC-3 (FR-3):** When successful checks of a live owned service execute in a
  different directory or after a default-folder change, handoff shall succeed
  without changing directory settings or recorded execution addresses.
- **AC-4 (FR-3/4):** If references are foreign, missing, unsuccessful, unfinished,
  pre-launch or forbidden observations, handoff shall reject with the specific
  reason. Stop/exit/replacement, stale revisions, lost replies and restart shall
  preserve the existing exactly-once receipt/watch/continuation behavior.
- **AC-5 (FR-5):** When frontend HTTP is healthy but an isolated application
  runtime is unavailable, the Agent acceptance trace shall show a real application
  check and report partial/failing startup without a readiness claim. The healthy
  counterpart shall check application behavior before handoff. A healthy sibling
  Runtime shall neither satisfy this check nor be mutated, and inspection shall
  not auto-start the failed target. A scripted provider
  fixture verifies plumbing, not general model compliance; record both separately.
- **AC-6 (FR-5):** When an IPv6-only service is advertised, checks shall address
  that endpoint correctly; a separate IPv4 refusal shall not be called a crash.
  An authorized immutable-tree cleanup fixture shall verify successful absence
  without a false nonzero result or weakening managed-Skill storage permissions.

Extend `validates active root authority and actual successful readiness lineage
before handoff` and `real gateway hands over a usable service silently and
delivers a finite result once` with actual Bash evidence; the existing first
fixture's `web_fetch` Items do not exercise cwd. Record fixed-fixture Agent call
counts, duration and retained outcomes before/after Unit B. Do not set a latency
or cost promise from the two observed Turns. Run typecheck, relevant Core tests,
focused built-Electron smoke, docs and diff checks for each complete feature.
Use temporary isolated data and synthetic images, never user screenshots as
committed fixtures. Update existing fixtures when #674 changes their entry seam.

### Existing-plan impact and collision boundaries

| Existing design | Required treatment |
| --- | --- |
| [Conversation work folders](conversation-work-folders.md), PR #674 | Consume the shipped Project/default-folder contract. Unit B owns the additional acceptance case: default-folder edits never redirect old services; authorized post-launch checks can use another directory; handoff consumes Task-owned references, not cwd equality. Preserve all Project/default-folder decisions and the archived design. Fold this clarification into the current Agent Core/tool specifications with Unit B; do not reopen #674's completed gate. |
| [Computer Pilot managed Skill](../computer-pilot-managed-skill.md) | Strengthen FR-3, AC-3 and packaged verification to require actual screenshot pixels after resource adoption and provider projection, including `.blob` storage. Consume Unit A's shared boundary; add no Computer-Pilot-specific decoder. This companion clarification is included with this design. CLI/acquisition preparation does not depend on Unit A. |
| [Scheduled work](../scheduled-work-redesign.md) | No design rewrite: BR-6/7, AC-11 and the Task-owner handoff already separate process observations from readiness and retain assignment location. Integration fixtures consume Unit B's final validator; do not add scheduling health checks, cwd-based membership, or another continuation owner. |
| [Targeted recovery](../targeted-thread-recovery.md) | No design rewrite: exact Task/resource closure and immutable observations already govern recovery. These units change no stored references or format. Preserve historical observations on restore and cover the final Task owner; do not turn a service timeout into permission for a whole-data reset. |
| [Performance](../performance-optimization.md) | No edit: its three measured optimization units do not own these correctness defects. Retry/call-count measurements stay in Unit B; do not expand that plan into a new performance program. |
| [Office preview](../file-preview-office.md) and [URL reader](../url-static-reader.md) | No design edit: extraction and network acquisition remain separate owners. Preserve their shared image consumers if the implementation overlaps; normalization creates no new fetch or preview authority. |
| [Memory/profile](memory-agent-profile.md), [Settings working states](../semantic-working-state.md), [floating toolbar](../floating-toolbar-polish.md), [dark-mode verification](../dark-mode-contrast-pass.md) | No changed premise or required implementation dependency was found. |

The active consumer designs and shipped #674 contract define the integration
boundary. Unit B consumes the final Host directory resolution, Task admission and
Thread/context owners from #674. Unit A stays image-local; shared `desktopHost`
edits must still be checked against open claims before implementation.

Archived `background-task-continuation-policy`, `startup-fault-isolation`,
`startup-window-first`, `generated-image-resources` and `workbench-tool-boundaries`
remain provenance. Correct current specs in implementation PRs rather than
rewriting their historical designs. Board/CHANGELOG and final merge ordering
remain main-owned. No claim is made that this draft ratifies another plan's
remaining product choices.

## Open questions

DEC-2/3 define the evidence contract: remove cwd equality while preserving
existing Task/Item association and all actual ownership/admission checks. Unit A
remains independent of this contract; no additional health-check protocol is
introduced.

**OQ-2:** What caused the original Outline Runtime timeout? Before proposing a
runtime fix, inspect the retained launch receipts/logs and reproduce with isolated
stores through `OutlineClientSupervisor.connect` and its startup-failure channel.
Distinguish child launch/exit, stale or incompatible descriptor/owner, locked store,
and a live Runtime that cannot serve the requested workspace. Preserve observed
facts before any user-authorized reset; avoid broadening the 10-second default
or adding retries without causal evidence. A reproducing case must identify the
failing owner and receive a concrete complete-fix design/acceptance amendment.
If reproduction remains unavailable, record that limit and leave the defect
unresolved; neither Unit A nor B claims to repair it.

The rejected global `cloudflare-pages-publish` Skill is an independent source
maintenance task: update its retired frontmatter through that Skill's owner,
without changing the application's validator. Repeated discovery-log suppression
and transcript retry grouping are optional follow-ups, not root-cause fixes or
prerequisites of these units.

## Implementation checklist

- [ ] Verify Unit B against the shipped #674 directory owner and its new acceptance case.
- [ ] Ship Unit A with actual pixel/provider-boundary evidence and owning specs.
- [ ] Ship Unit B with Task authority, application verification and restart fixtures.
- [ ] Complete the bounded startup investigation; add a causal fix only when supported.
- [ ] Recheck affected consumer plans against final owners and pass required checks.
