# Agent Permission Redesign — Consequence-Based, Delegated Operator

Supersedes the draft `agent-delegated-scope-permissions.md` (PR #249). That draft
diagnosed the right problems but kept the legacy frame (three modes as
"compatibility storage", a parallel `OperationEffect` enum next to the existing
descriptors, a deferred-but-still-workspace-shaped "delegated areas" UI). This
plan keeps the diagnosis and discards the frame: the app is pre-release, so we
rebuild the model into its simplest honest shape rather than layer onto the
current one.

## Goal

The agent is the user's **delegated operator**, not an untrusted stranger.
Whatever the user could reasonably do, the agent may do — silently — and the
system interrupts only to let the user pull a trigger they should own, and
refuses only what the user would never intend.

Concretely, collapse today's `enum × 3 modes × dead classifier × shell
allowlist` decision tangle into **one pure function over an operation's
consequence**, with exactly three outcomes:

```text
WORK    -> allow  (silent)   the agent's default mode of being
COMMIT  -> confirm (once, or remember as a narrow grant)
FORBIDDEN -> block (the safety floor; non-configurable)
```

This deletes the source of the "too cautious / too many prompts" experience: the
model is no longer a *whitelist* (default-deny, allow item by item) but a
*blocklist* (default-allow, block only catastrophes + confirm only world-commits).

## Non-goals

- Do not weaken Electron/native hardening, CSP, navigation blocking, renderer
  sandboxing, userData isolation, or secret storage (A3). The model change is
  above the seam, not in the host hardening.
- Do not let the model decide whether a confirm is needed. The runtime owns the
  decision; the LLM never owns permissions.
- Do not treat "has side effects" as "dangerous". Local reversible mutation is
  ordinary work, not a boundary.
- Do not invent a workspace entity. "Scope" is one reduced concept (see below)
  and its only grant gesture is the folder handoff — consistent with the ratified
  `no-workspace-concept` direction (trust is global; the handoff gesture *is* the
  trust grant, no separate trust dialog).
- No migrations. Pre-release: a stale `agent-tool-permissions.json` /
  `safetyMode` normalizes or is wiped (`storage-format-no-backcompat-prerelease`).

## The model (the spine)

### Two — and only two — honest reasons to interrupt or refuse

1. **COMMIT** — the action commits something to the world the user can't take
   back, or reaches outside what the user handed Tenon: send/publish/push/deploy,
   payment, network *writes*, external-service mutation, irreversible real-world
   acts, touching files/systems outside the handed scope, reading credentials.
   The user (the principal) should pull that trigger, or pre-authorize the class.
   → **confirm once**, with an offer to **remember a narrow grant**.

2. **FORBIDDEN (safety floor)** — the action is something the user would never
   intend: an attack or catastrophe. → **block**, always, not configurable.

Everything else is **WORK** → **allow, silently**: read, write, edit, reorganize,
transform files, run local build/test/validation/tooling, search, fetch pages,
fix its own mistakes.

### Three outcomes, one decision function

The entire decision core becomes one pure function over a projected `Effect`:

```ts
function decide(effect: Effect): 'allow' | 'confirm' | 'block' {
  if (effect.floor)                     return 'block';   // catastrophe
  if (effect.reach === 'network_read')  return 'allow';   // reading the world (fetch/search)
  if (effect.reach === 'local'
      && effect.reversible
      && !effect.touchesCredentials)    return 'allow';   // local, reversible, non-credential
  return 'confirm';                                        // commit: trigger-pull, remember
}

interface Effect {
  reach: 'local' | 'outside_scope' | 'network_read' | 'network_write' | 'external_system';
  reversible: boolean;          // is there an undo / trash / diff?
  touchesCredentials: boolean;  // credential / secret path
  floor?: FloorKind;            // exfiltration | host_destruction | persistence
                                // | hidden_exec | permission_self_mod | payment
  label: string;                // human-readable, for audit only ("run bun test")
}
```

There is **one** classification (the `Effect`), derived per tool call. The ~40
`AgentToolActionKind` values survive only as audit/identity **labels**, never as
the decision key. There is no second taxonomy to maintain.

### Reversibility is the freedom lever

The cleaner the undo story, the more an operation qualifies as WORK. So the
design *invests in reversibility to widen silent-allow*, rather than asking
permission for reversible things:

- **File delete → move to an agent trash** (recoverable) instead of `unlink`.
  Delete becomes WORK, not a confirm. Whole-tree / root / home deletes are still
  FORBIDDEN (host destruction).
- **Outliner ops** are already undoable/evented → WORK.
- **File write/edit** already emit a diff into the transcript → traceable → WORK.

"We don't ask to do reversible things; we make more things reversible."

### Scope, reduced to a single role (= the folder handoff)

Place stops being the organizing axis. It keeps exactly one job: **the set of
roots the user has handed Tenon.**

- Local work *inside* the handed scope → WORK.
- Reaching *outside* it (read or write, via file tool **or** bash) →
  `reach: 'outside_scope'` → COMMIT (confirm once; remember as a `scope` grant).
- **Granting a folder is that same confirm.** "Hand Tenon this folder" adds a
  root to the handed scope. The folder-handoff gesture is therefore not a new
  subsystem — it is the UI for one `Grant` kind. (Honors `no-workspace-concept`.)

This also removes today's bash/file-tool inconsistency: today `bash cat
~/other/x` is allowed (bash has no path containment) while `file_read
~/other/x` is blocked. In the new model **both** route through the same scope
check.

### The credential exception (the one principled carve-out)

The user can read their own `~/.ssh`, so the agent "can" too — but reading
credentials is the first thing a hijacked prompt would do. So:

- **credential read → COMMIT** (confirm once), even inside the handed scope.
- **credential + outward sink (network/opaque) → FORBIDDEN** (exfiltration).

One cheap confirm for credential reads; exfiltration is blocked outright. This is
the single place where "agent = user" is deliberately narrowed, and it is the PM-
ratified posture.

### The safety floor (the only hard blocks) — now load-bearing

Because shell inverts to default-allow, the floor becomes **the only wall between
the agent and the shell**, so it is hardened and fuzz-tested rather than trusted
as-is. The floor is narrow, named, and non-configurable:

- **exfiltration** — a sensitive path combined with a network/opaque sink
  (`looksLikeExfiltrationSink` + `SENSITIVE_PATH_PATTERNS`, kept and extended).
- **host_destruction** — recursive root/home/whole-scope delete, `mkfs` /
  `diskutil erase`, raw `dd of=/dev/disk`, `shutdown`/`reboot`, `chmod`/`chown -R
  /` (`BASH_HARD_DENY_RULES`, kept).
- **persistence / self-amplification** — writes to shell rc files, crontab,
  LaunchAgents, systemd user units, `.git/{hooks,config,…}`, and the agent's own
  permission/provider/secret stores (kept).
- **hidden_exec** — dynamic/obfuscated construction and remote-code pipes:
  backticks/`$( )`, `eval`, `base64 -d | sh`, `curl … | sh`. These are the *only*
  shell forms that block; a plain unrecognized **static** command is WORK, not a
  block.
- **permission_self_mod** — `agent.permission.modify` (already a never-allow
  guardrail; no tool produces it).
- **payment** — `payment.purchase` (already a never-allow guardrail).

### Grants — narrow by construction

A COMMIT's "remember" stores exactly the boundary the user authorized — never a
whole action kind (today's `Action(shell.project_script)` over-grant is deleted):

```ts
type Grant =
  | { kind: 'scope';    root: string }     // = "I handed Tenon this folder"
  | { kind: 'external'; target: string }   // "push to this remote" / "send via this account"
  | { kind: 'command';  form: string };    // a specific external command form (last resort)
```

A matching grant flips its COMMIT to ALLOW on re-evaluation. Approvals trend to
zero with use — the correct way to cut prompts (narrow granularity + always
rememberable), not a global escape hatch.

## What this deletes vs keeps

**Delete (legacy frame the PM authorized cutting):**

- `AgentSafetyMode` entirely — `ask_first` / `balanced` / `full_access`,
  `safetyModeDefaultActionDecision`, `ASK_FIRST_ASK_ACTIONS`,
  `FULL_ACCESS_ALLOW_ACTIONS`, the Settings mode selector, the
  "Hand everything to Lin" card action + its `window.confirm`, and
  `resolveApproval`'s `full_access` scope.
- The dead LLM classifier path — `agentPermissionClassifier.ts`,
  `classifierAutoAllowEligible`, and the classifier branch of the ask resolver
  (every shipped descriptor already sets it `false`; it never runs in prod).
- The shell **allowlist** (`isReadOnlyShellCommand`) and `shell.unknown`-as-hard-
  block. Replaced by floor-detection + commit-detection; unknown static commands
  are WORK.
- Broad `Action(kind)` as the remember primitive (`alwaysAllowRuleForDescriptor`)
  → replaced by `Grant`.
- The ~40-kind decision table *as the decision key* (kinds stay as audit labels).

**Keep (the good bones):**

- The central seam `evaluateAgentToolPermission` — one chokepoint, shared by the
  main runtime and skill-shell. The function body shrinks to `project → decide`.
- The realpath/symlink-safe file resolver `resolveWorkspacePath`
  (`agentLocalTools.ts`) — and extend its containment idea to the bash scope
  check (see Enforcement).
- The safety-floor detectors (hardened + fuzzed).
- The grant store (`agentToolPermissionStore.ts`), reshaped to hold `Grant`s.
- The skill restricted sandbox (`restricted` mode + `preapprovedToolRules`) — an
  orthogonal, voluntary self-narrowing of a *skill*, unchanged.
- Skill ratification (invocation-time content-hash trust) — orthogonal to
  permissions, kept as-is (`agent-skill-write-gate-removed`).
- The audit/event log — strengthened: more freedom ⇒ stronger trace.

## Enforcement layers (defense in depth survives the model change)

The decision layer is only as safe as the enforcement under it:

1. **File tools** stay realpath-contained to the handed scope
   (`resolveWorkspacePath`, already symlink-safe with a test).
2. **Bash** gains a path-extraction pass that feeds the **same** scope check, so
   `reach: 'outside_scope'` triggers a COMMIT even via the shell (closes today's
   uncontained-bash gap). Floor detection runs first on the whole command.
3. **Sensitive-path + sink** detection (the exfiltration floor) runs on every
   bash command regardless of scope.

## Evaluation pipeline (new, slim)

`beforeToolCall` (the only entry) does:

1. **Project** the tool call into an `Effect` (`projectEffect(toolName, args,
   scope)`), running floor detectors and scope/credential/reversibility checks.
2. **Floor short-circuit** → block + tell-only notice.
3. **Grant lookup** → a matching `Grant` flips a would-be COMMIT to allow.
4. **`decide(effect)`** → `allow | confirm | block`.
5. **confirm** → interactive run suspends and requests approval; unattended run
   returns structured `permission_denied` (absence is never approval).

No modes, no classifier, no allowlist. Same precedence guarantee as today
(floor can never be allow-ruled away).

## Shape & build order

**Shape (b): a SET of independent complete features**, ordered by dependency.
Each is its own PR, each independently reviewable and shippable; none is a
partial slice of another. `src/core/agentPermissionModel.ts` is a shared surface
(the `/research` read-only partition consumes it), so PR-1 lands as the
interface-bearing change and consumers rebase onto it (A7, shared-interface-first).

- **PR-1 — the model core (the reversal).** Replace the decision core with
  `Effect` + `decide()`; delete safety modes, the dead classifier, the shell
  allowlist; reshape the store to `Grant`; harden + fuzz the floor; add the
  agent-trash so delete is reversible; bash path-extraction into the scope check;
  rewrite the approval card to `Allow once / Always (this boundary) / Deny` +
  tell-only floor notices. Spec sync in the same change. **This is the coherent
  end-to-end semantic replacement** — it ships whole, never half.
- **PR-2 — folder-handoff gesture.** The UI + persistence for a `scope` grant:
  the user hands Tenon a real folder, which becomes a handed-scope root so the
  agent can finally work on the user's real files (today the default workdir is an
  empty `<userData>/agent-workdir`). Builds directly on PR-1's `Grant` mechanism.
  PM-ratified as in-scope for this round.
- **PR-3 — typed `file_convert` tool.** A first-class PPT/PDF/image conversion
  tool using `spawn(file, argv, { shell: false })`, paths resolved through the
  handed-scope rules, structured tool-result audit. Reduces shell surface for the
  highest-frequency workflow while staying WORK inside scope. Builds on PR-1's
  effect model.

The `/research` read-only capability re-expresses cleanly on the new model:
read-only = "may only produce `Effect`s with `reach ∈ {local, network_read}` and
no mutation" — the read-only partition becomes a property of the effect, not a
hand-listed catalog. Coordinate the partition's new home with the research owner.

## Spec sync (same change as the behavior, A6)

- Rewrite `docs/spec/agent-tool-permissions.md` to the `Effect`/`decide` model,
  the three outcomes, the floor, the handed scope, and grants. Delete the
  safety-mode, classifier, and allowlist sections; record the deletions under a
  short "What changed from the mode model" note.
- `docs/spec/agent-tool-design.md` — the `file_convert` tool and the bash
  scope/floor behavior.
- `docs/spec/agent-skills.md` — confirm restricted sandbox + ratification are
  unchanged and orthogonal.

## Tests

- **Decision matrix** over `decide(effect)`: each `reach × reversible ×
  credentials × floor` combination resolves to the expected outcome.
- **Shell reversal**: `which soffice`, `command -v libreoffice`, `soffice
  --convert-to pdf`, and arbitrary unrecognized **static** commands all ALLOW;
  `curl … | sh`, `eval`, base64-pipe-to-sh, `rm -rf /` BLOCK; `git push`, deploy,
  network-write CONFIRM. No allowlist is consulted.
- **Floor hardening / fuzz**: exfiltration (sensitive + sink), host destruction,
  persistence writes, hidden/obfuscated exec — property/fuzz tests, since the
  floor is now the only shell wall.
- **Scope**: reaching outside the handed scope via file tool *and* via bash both
  CONFIRM; symlink escape stays blocked at the resolver.
- **Reversibility**: deletes go to agent-trash and are recoverable; whole-scope/
  root delete BLOCK.
- **Credentials**: credential read CONFIRMs; credential + sink BLOCKS.
- **Grants**: a `scope`/`external`/`command` grant flips its COMMIT to allow;
  proves grants can never bypass the floor.
- **Skill-shell parity** through the shared evaluator; **restricted sandbox** and
  **skill ratification** unaffected.
- **Approval UI**: COMMIT cards show Allow-once / Always-this-boundary / Deny;
  floor notices are dismiss-only; no mode/full-access affordance remains.

## Open questions

- **Default handed scope.** With the folder-handoff gesture in (PR-2), should the
  default scope on first run stay the app-owned workdir until the user hands a
  folder, or auto-offer the current document's backing location? (Leaning:
  app-owned default; the gesture is the explicit, auditable grant.)
- **`command` grants vs re-confirm.** For external command forms with no safer
  `scope`/`external` representation, do we persist a `command` grant or always
  re-confirm? (Leaning: persist, last resort, exact-form only.)
- **`/research` partition home.** Confirm with the research owner where the
  read-only effect predicate lives so there is one source, not two.
