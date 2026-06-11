---
status: draft
owner: codex
updated: 2026-06-11
---

# Agent Permission Safety Modes

## Goal

Unify Lin's user-facing agent security model around one concept: **trust**.

Users should not have to understand action-kind rows, skill ratification chips,
agent `restricted` modes, JSON permission rules, and hard-denial failures as
separate systems. The product should expose:

1. one global trust level;
2. one interrupt card;
3. one Security page for grants, revocation, sensitive access, and recent
   permission activity.

The runtime keeps the existing descriptor-based permission evaluator and hard
redlines. The new mode ladder decides what happens when no explicit trust grant
applies.

This is a design proposal for main/PM review, not an implementation PR.

## Non-goals

- Do not relax Electron renderer hardening, CSP, window navigation policy,
  OS-permission allow-lists, `userData` isolation, or secret storage.
- Do not weaken hard blocks for host destruction, credential exfiltration,
  persistence writes, unknown shell, permission modification, or payments.
- Do not encode Full Access by materializing broad global allow rules.
- Do not expose the delegation sandbox as a user trust level.
- Do not add per-workspace trust storage now. The product has no user-visible
  folder handoff yet.
- Do not add migrations. Pre-release settings normalize-or-default at read time;
  no legacy reader is kept.

## Current State

The shipped product has two permission modes:

- `trusted`: runtime default.
- `restricted`: a deny-non-preapproved tool sandbox used by custom agents,
  subagents, and skill `allowed-tools`.

`AgentPermissionMode = 'trusted' | 'restricted'` is a protocol surface. Settings
normalization accepts only those values. Custom agent authoring exposes
Inherit/Restricted/Trusted even though `restricted` is really an internal
delegation mechanism rather than a consumer trust posture.

Every governed tool call goes through the same runtime seam:
`agentRuntime.ts` `beforeToolCall` loads global permission rules, combines skill
and subagent preapproval rules, and calls `evaluateAgentToolPermission`. That
evaluator derives `ToolActionDescriptor`s and returns exactly one of `allow`,
`ask`, or `deny`.

The decision engine is already the right foundation:

- Descriptors classify action kind, access scope, default decision, reversibility,
  external effect, high consequence, and optional platform hard block.
- Platform hard blocks are evaluated before global rules.
- Configured deny wins.
- `restricted` currently denies non-preapproved tools before descriptor defaults
  can allow or ask.
- Configured allow/ask rules then refine descriptor defaults inside the parser's
  allowed envelope.
- Compound shell commands aggregate the most restrictive segment decision.

Current descriptor defaults are mixed:

- Allowed by default: allowed-root file reads/writes, outliner edits, web search,
  memory recall, status/config reads, safe read/search shell commands.
- Ask by default: web fetch, node delete, local code execution/project scripts,
  dependency install, network writes, git push/GitHub mutation, deploy/publish,
  file delete, subagent spawn, skill writes, Dream, config writes, sensitive path
  reads, background processes, sandbox override.
- Denied/hard-blocked: unknown shell, outside-root access unless the run opted
  into outside access, credential/persistence/git-internal writes,
  sensitive-data exfiltration, destructive host commands, permission
  modification, and payment purchase.

Global permissions are stored as `agent-tool-permissions.json` under `userData`
with `{ permissions: { allow, ask, deny } }`. Parsing is intentionally
fail-closed. Many high-leverage actions cannot be globally allowed today:
`agent.config.write`, `agent.memory.dream`, `agent.skill.write`,
`agent.subagent.spawn`, `shell.unknown`, and broad/arbitrary `Bash(...)` rules.
This is correct and should not be weakened to fake a Full Access mode.

The approval card supports `Approve once`, `Always allow` when a validated
`Action(...)` rule exists, and `Deny once`. Skill trust has a separate Settings
flow: project skills and agent-authored skills are hidden from automatic model
use until accepted. A model-triggered unaccepted skill currently fails in chat and
points users to Settings.

The ask resolver is conservative. Explicit configured asks always ask; safe-read
allow-list descriptors can auto-allow; every shipped descriptor currently has
`classifierAutoAllowEligible: false`, so the classifier path is effectively dead
in production. If no approval channel exists, an ask becomes a structured
permission denial. Skill embedded shell uses the same evaluator and ask resolver.

The native host security shell is separate from agent trust: renderer windows
keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; the
packaged renderer gets CSP; navigation is blocked or opened externally; Electron
permissions are denied except sanitized clipboard write; single-instance and
before-quit flush stay fixed. These are safety-floor controls, not mode controls.

## Product Fact: No Workspace Yet

The original proposal modeled trust around a workspace identity. That is not a
shipped product concept.

Today the agent local file root is set once at launch:

```ts
const agentLocalFileRoot = process.env.LIN_AGENT_LOCAL_ROOT ?? process.cwd();
```

There is no folder picker, no per-conversation root, and no renderer-visible
workspace/folder trust surface. The "workspace = project clone" experience exists
for developers because dev scripts launch from repo clones. Consumers using the
packaged app do not choose a workspace.

Therefore the current product should use **global app trust**:

- one global `safetyMode`;
- one global trust ledger;
- no `WorkspaceTrustSettings`;
- no workspace identity resolver;
- no per-workspace mode override;
- no batch-accept-per-workspace skill mechanism.

Later, if Lin introduces an explicit "hand Lin a folder" gesture, that gesture is
the trust moment. Picking the folder records one revocable ledger grant. No
separate VS Code-style trust dialog is needed because the functional action and
the trust grant are the same user gesture.

## Required Precursor: Local Root Boundary

This plan must not ship on top of an unbounded file root.

If a packaged app launched from Finder gets `process.cwd() === "/"`, the current
fallback makes the permission engine treat the whole disk as the allowed file
area. Sensitive paths still have separate descriptors, but ordinary paths
outside the app's intended local area would default as in-root. Full Access on
top of that boundary would be full disk access.

This is independent of the mode ladder and should be verified/fixed first. The
separate filed item is `docs/plans/agent-local-root-boundary.md`.

## Product Problem

Today the user-facing security surface is fragmented.

Interrupts:

- approval cards;
- structured denials that can read as silent failures;
- pending skill failures in chat with remediation hidden in Settings.

Configuration surfaces:

- Permissions pane with action rows and JSON diagnostics;
- Skills pane with pending/accepted chips and accept/revoke controls;
- Agent editor with Inherit/Restricted/Trusted;
- hand-edited permission JSON;
- unexposed outside-root flags.

Vocabularies:

- `trusted` / `restricted`;
- `Ask first` / `Always allow`;
- pending / accepted skill trust;
- `allow` / `ask` / `deny`.

Those surfaces all express the same underlying judgment:

```text
principal x scope x capability -> allow | ask | deny
```

The engine already implements that judgment once. The product should stop
presenting each grant family as a separate feature.

## Four-Layer Model

### 1. Safety floor

Invisible and non-configurable:

- Electron/native hardening;
- platform hard blocks;
- credential and persistence redlines;
- sensitive-data exfiltration blocks;
- unknown shell deny;
- permission/payment modification deny;
- secret storage decisions.

No trust level or ledger fact can bypass this layer.

### 2. Trust ledger

Everything the user has granted is one fact type:

```ts
interface TrustGrant {
  id: string;
  subject: 'user' | 'system';
  scope: 'global' | { kind: 'folder'; root: string }; // folder is future-only
  grant:
    | { kind: 'action'; actionKind: AgentToolActionKind }
    | { kind: 'skill_hash'; skillFile: string; contentHash: string; source: 'user' | 'project' }
    | { kind: 'sensitive_files' }
    | { kind: 'folder_access'; root: string };
  provenance:
    | { kind: 'approval_card'; conversationId?: string; requestId?: string }
    | { kind: 'settings' }
    | { kind: 'future_folder_handoff' };
  createdAt: number;
  revokedAt?: number;
}
```

An "always allow web fetch" action, an accepted skill hash, and a future handed
folder are instances of the same ledger. Each is individually revocable and shown
in one Security page.

This does not require collapsing all current stores in the first implementation.
The plan requires one product abstraction and one renderer view. The backing
implementation can adapt the existing global permission store and skill
provenance store behind a ledger-shaped projection, then consolidate storage
later if needed.

### 3. Default policy

The mode ladder defines what happens when the safety floor allows the action and
no ledger fact speaks.

Recommended global trust levels:

| UI name | Internal id | Default policy |
| --- | --- | --- |
| Ask First | `ask_first` | Allow passive reads/searches/status. Ask before local edits, deletes, shell execution, web fetch, external effects, skill acceptance, subagents, config writes, and Dream. |
| Balanced | `balanced` | Recommended default. Preserve today's effective `trusted` behavior: allow ordinary outline/file edits and passive reads; ask for execution, deletes, dependency installs, web fetch, external mutations, sensitive/outside paths, subagents, skill writes, config writes, Dream, and unaccepted skills. |
| Full Access | `full_access` | Lowest-friction automation. Allow classified non-redline local execution, allowed-root edits and deletes, web fetch, dependency install, network writes, git push/GitHub mutation, subagents, Dream, and accepted skill invocation. Keep deploy/publish, sandbox override, sensitive local reads, agent-authored skill acceptance, unknown shell, and all hard redlines out of the automatic allow set. |

I recommend shipping three trust levels. `Read Only` is a task posture ("analyze
this, do not touch anything"), not a trust posture. It belongs later as a
per-conversation toggle, similar to a plan-mode constraint, not on the global
trust ladder. PM can still choose to keep four modes; the engine shape is the
same.

### 4. Delegation sandbox

This is internal and should not appear in user vocabulary.

The existing `restricted` behavior remains useful for custom agents, subagents,
and skills: deny non-preapproved tools under a preapproval envelope. It is not a
global user trust level and must not map to `ask_first`.

Custom agents become narrow-only relative to the global trust level:

- "Follow global" (default);
- "Restricted" (deny non-preapproved tools).

They must not widen above the global mode through a user-facing setting. This
settles the old open question about custom-agent widening.

Explicitly not unified into the trust ledger:

- the delegation sandbox itself;
- Electron/native hardening;
- secret storage;
- provider authentication;
- payment/permission-management hard blocks.

Forcing these into the ledger would dirty the abstraction. They remain safety
floor or internal mechanism.

## Trust Level Semantics

Recommended profile decisions:

| Action category | Ask First | Balanced | Full Access |
| --- | --- | --- | --- |
| Local/outliner reads, search, status | allow | allow | allow |
| Local/outliner edits | ask | allow | allow |
| Local deletes | ask | ask | allow |
| Read outside current root | ask only if the run opted into outside access | ask only if the run opted into outside access | ask until a future folder handoff exists |
| Sensitive local reads | ask behind separate opt-in | ask behind separate opt-in | ask behind separate opt-in |
| Sensitive/persistence writes | deny | deny | deny |
| Web search | allow | allow | allow |
| Web fetch | ask | ask | allow |
| Local project scripts/code execution | ask | ask | allow |
| Dependency install | ask | ask | allow |
| Network write | ask | ask | allow |
| Git/GitHub mutation | ask | ask | allow |
| Deploy/publish | ask | ask | ask |
| Background process | ask | ask | allow, with visible running task state |
| Sandbox override | ask | ask | ask |
| Skill write | ask | ask | allow write, but agent-authored skill trust still requires explicit acceptance |
| Skill automatic use | ask/accept via card | accepted skills only | accepted skills plus human-authored global trust defaults |
| Subagent spawn | ask | ask | allow |
| Config write | ask | ask | ask |
| Dream write | ask | ask | allow |
| Unknown shell | deny with tell-only card | deny with tell-only card | deny with tell-only card |

Open Q2 is resolved in this proposal:

- git push and GitHub mutation are allowed in Full Access because they are common
  and usually recoverable;
- deploy/publish remains ask even in Full Access because it is less frequent and
  costliest to reverse.

Sensitive local reads are never bundled into a trust level. They require the
independent "Read sensitive computer files" switch in Security.

## Skill Trust and Self-Amplification

Full Access must not create a self-amplification loop.

Rule:

```text
auto trust never applies when current skill content is agent-authored
contentHash === agentHash => explicit user acceptance required in every mode
```

The provenance store already tracks `agentHash`, so the evaluator can preserve
the existing asymmetry:

- human-authored or hand-edited skill content may auto-ratify under Full Access;
- agent-authored skill content always raises an in-flow review/accept card;
- accepting a skill records the exact content hash in the trust ledger;
- changing the bytes invalidates that grant unless the new content is human-
  authored and the default policy permits auto-ratification.

The user-facing explanation should be simple:

> Lin created or changed a skill for itself. Review it before it can run
> automatically.

Skill trust remains a trust fact, not a permission bypass. A skill's
`allowed-tools` still narrows or preapproves downstream calls within the
permission engine, and the safety floor still applies.

## The Card

All mid-flow security contact should use one card.

For ask decisions, exits are ordered by prominence:

1. **Allow once** — the only primary button; Enter-able.
2. **Always allow this action** — secondary; writes an action trust grant.
3. **Hand everything to Lin, stop asking** — secondary/destructive-style trust
   escalation; switches global mode to Full Access.
4. **Deny**.

Rationale:

- Every interruption is also the upgrade path.
- Users escalate trust exactly when friction occurs, not by discovering Settings.
- The card remains a two-key decision for novices: primary allow, secondary deny.
  Trust escalation exits are visually secondary so the card is not a quiz.

Skill acceptance moves into the same card:

- First automatic model use of an unaccepted skill raises:
  "Skill X requests automatic use."
- Exits: View, Accept, Not now.
- Agent-authored skills always use this path, including in Full Access.
- Settings still lists skills, but no chat failure should send users hunting for
  a hidden remedy.

Hard denials use the same card in tell-only form:

- what was blocked;
- why it was blocked;
- raw command or target;
- View command/details;
- Re-run with explicit approval, when a safe explicit path exists.

The decision remains `deny`; only the presentation changes. This is especially
important in Full Access, where silent `shell.unknown` denial would otherwise
feel contradictory.

## Settings IA

Replace the Permissions page with a **Security** page.

```text
Security
  1. Trust level
     Ask First / Balanced (recommended) / Full Access

  2. Granted trust
     One revocable list:
       - action allows
       - accepted skill hashes
       - future folder grants
     Each row shows what, when, provenance, and Revoke.

  3. Sensitive access
     "Read sensitive computer files" independent switch, default OFF.
     This is not included in any trust level.

  4. Recent activity
     Human-readable permission event feed.

  Advanced
     Existing action rows and Ignored JSON Rules, unchanged.
```

Related pages:

- Agent editor: remove Trusted/Restricted vocabulary. Expose only "Follow global"
  and "Restricted" (narrow-only delegation sandbox).
- Skills page: keep functional management (enable/disable, view, undo agent
  edit). Trust chips/buttons become a second view of the same ledger facts, not a
  separate trust system.

Migration map:

- Current global `permissionMode: trusted` -> `safetyMode: balanced`.
- Current global `permissionMode: restricted` -> `safetyMode: ask_first` only for
  the app-level setting.
- Agent-definition `permission-mode: restricted` -> delegation sandbox
  `Restricted`.
- Agent-definition `permission-mode: trusted` -> default/inherit, because agents
  are narrow-only.
- Permissions rows -> Advanced, verbatim.
- JSON diagnostics -> Advanced, verbatim.
- Skill accept/revoke -> ledger facts; Skills page keeps a view.
- Hand-edited JSON -> unchanged expert backdoor.
- Outside-root flags -> stay unexposed until an explicit folder handoff product
  exists.

## Consumer Experience Acceptance Bar

The revised design should satisfy these product properties:

- Security decisions required before first use: **0**. Default Balanced works
  immediately.
- Decisions for a fully smooth experience: **1**. One tap on "stop asking" from
  the card when the user actually feels friction.
- Concepts to understand: **1**: trust.
- Interrupt forms: **1**: the card, with a tell-only variant for blocks.
- Management surfaces: **1**: Security.
- Pure outliner usage: **0 permission touchpoints, ever**. A user who only
  creates, edits, and organizes outline content must not see trust prompts.
  Outline editing is allowed in Balanced and Full Access; the product should
  protect this property in tests.

## Engine Design

Do not encode modes by writing many global allow/ask rules. Keep a first-class
default-policy layer in the evaluator.

Suggested pipeline:

1. Derive descriptors exactly as today.
2. Apply safety-floor platform hard blocks exactly as today.
3. Apply configured deny rules and revoked ledger facts.
4. Apply explicit trust ledger grants.
5. Apply default safety-mode profile decision.
6. Apply configured ask/allow advanced overrides inside the allowed override
   envelope.
7. Route `ask` through the existing ask resolver/card.
8. Emit permission events.

Mode-derived events need a stable source value, for example:

```ts
type AgentPermissionEventSource =
  | 'configured_allow'
  | 'configured_ask'
  | 'configured_deny'
  | 'safety_mode_profile'
  | 'trust_ledger'
  | 'safe_allowlist'
  | 'classifier'
  | 'runtime'
  | 'user';
```

The exact union lives with the event taxonomy, but the plan must reserve a
distinct `safety_mode_profile` source so audit and debugging can distinguish
mode-derived allows from explicit grants.

## Coordination Requirements

- Rename or replace `AgentPermissionMode` with `AgentSafetyMode` for the
  user-facing default policy. Record this in `docs/plans/agent-program.md` F6 as
  a post-M0 protocol revision in the same implementation change.
- Keep the delegation sandbox as a separate internal mechanism.
- Add `safety_mode_profile` / `trust_ledger` event-source mapping wherever
  permission events are specified.
- No `WorkspaceTrustSettings` or agent-data-model §5 addition is needed now,
  because there is no folder handoff product.
- Implementation should rebase after #184 (`cc-2/agent-run-unification`) because
  that PR touches adjacent runtime permission flow.
- Normalize-or-default old setting values at read time. Do not keep legacy
  readers.
- The local-root boundary verification/fix is sequenced before implementing Full
  Access.

## Implementation Plan

This is one complete feature PR after PM/main ratification.

1. Protocol and settings:
   - Add `AgentSafetyMode = 'ask_first' | 'balanced' | 'full_access'`.
   - Normalize old global `trusted`/`restricted`.
   - Update runtime settings, agent authoring parsing/serialization, i18n, and
     specs.
2. Delegation sandbox:
   - Preserve restricted deny-non-preapproved behavior.
   - Change Agent editor UI to Follow global / Restricted.
   - Ensure agent definitions can only narrow relative to global policy.
3. Trust ledger projection:
   - Add a ledger-shaped view over action grants and skill hash grants.
   - Keep existing stores initially if that reduces risk.
   - Make grants individually revocable from Security.
4. Mode profile evaluation:
   - Insert safety-mode default decisions after safety floor and explicit ledger
     grants.
   - Keep hard blocks and ask resolver unchanged.
   - Add permission event sources for mode and ledger decisions.
5. Unified card:
   - Add graduated exits for ask cards.
   - Move skill acceptance into the card.
   - Add tell-only cards for hard denials.
6. Security page:
   - Replace Permissions top-level IA with Trust level, Granted trust, Sensitive
     access, Recent activity, and Advanced.
   - Keep Skills page as a secondary view for skill management/trust.
7. Specs and tests:
   - Update `docs/spec/agent-tool-permissions.md`.
   - Update `docs/spec/agent-skills.md`.
   - Update `docs/plans/agent-program.md` F6 coordination notes.
   - Core tests for mode matrix, ledger grants, hard floors, restricted sandbox,
     agent-authored skill acceptance, event sources, and local-root guard.
   - Renderer/e2e tests for Security page, card exits, skill acceptance card,
     tell-only denial card, and pure-outline zero-touch behavior.

## Acceptance Criteria

- The app exposes one global trust level: Ask First, Balanced, or Full Access.
- Balanced preserves today's practical default behavior while using the new IA.
- Full Access allows classified non-redline routine automation without prompts.
- Deploy/publish, sandbox override, sensitive local reads, agent-authored skill
  automatic use, unknown shell, and safety-floor redlines are not silently
  auto-allowed by Full Access.
- All user grants appear in one revocable Security ledger view.
- Skill acceptance can happen in-flow from the card.
- Hard denials are visible tell-only cards, not silent structured failures.
- Custom agents can only follow global policy or narrow into the restricted
  delegation sandbox.
- Permission events distinguish safety-mode decisions and explicit trust grants.
- Pure outline creation/editing never triggers permission UI.
- Old `trusted`/`restricted` settings normalize deterministically at read time.

## Risks

- Full Access can surprise users if it includes external mutation. Mitigation:
  put git/GitHub mutation in Full Access but keep deploy/publish as ask; show
  recent activity and cheap revoke.
- Too many card exits can feel like a quiz. Mitigation: one primary button
  (`Allow once`); escalation exits are secondary.
- A ledger abstraction can become a storage migration sink. Mitigation: ship a
  ledger projection first; consolidate stores later only if it removes real
  complexity.
- "Sensitive computer files" is hard to explain. Mitigation: keep it separate
  from trust levels and default OFF.
- The local-root boundary may be unsafe in packaged builds. Mitigation: verify
  and fix before implementation.

## Open Questions for PM

1. Ship three trust levels now, or keep Read Only as a fourth global level despite
   it being a task posture?
2. Should "Hand everything to Lin, stop asking" appear on every approval card or
   only after repeated prompts?
3. Should Full Access include all GitHub CLI mutations, or only git push and PR
   creation/update classes?
4. Should the ledger projection preserve the old Permissions page URL/route as an
   Advanced subroute for continuity?

## Collision Check

Open PRs checked on 2026-06-11:

- #186 `codex-2/focus-selection-polish`: no direct overlap; UI focus/selection.
- #184 `cc-2/agent-run-unification`: adjacent runtime permission flow; no direct
  docs-file overlap. Implementation must sequence behind or rebase over #184.
