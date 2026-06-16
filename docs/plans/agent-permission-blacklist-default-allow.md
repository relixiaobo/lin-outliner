# Agent Permission Blacklist — Default Allow for Novice Users

## Goal

Make Tenon's agent permissions match the real user base: most users are novices,
and an approval prompt does not create meaningful informed consent. If the agent
asks, they will usually click approve. The product should therefore stop
pretending that frequent permission cards are a safety mechanism.

Replace tool permission prompts with a **default-allow blocklist model**:

- normal agent work runs silently;
- the runtime keeps a tiny non-configurable redline and a small user-overridable
  soft blocklist;
- users can add blocks from the execution log after seeing what happened;
- logs become the accountability and correction surface, not a stream of
  interruptive preflight prompts.

This is a user-experience change and a permission-model change. It keeps the
Electron/native security floor intact: process isolation, CSP, navigation
guards, secret storage, userData isolation, local path containment, and platform
hardening are not relaxed.

## Non-goals

- Do not give the model authority to disable the runtime redline. The model
  may choose actions, but the host still owns catastrophic blocks.
- Do not remove logging. Default allow only works if tool calls, permission
  decisions, and results remain durable and inspectable.
- Do not keep approval prompts as a "maybe useful" fallback for ordinary tool
  calls. If prompts stay common, the design has not solved the user problem.
- Do not weaken `restricted` skill/agent sandbox semantics for authored agents.
  Run-scoped `allowed-tools` still narrows what a restricted skill or delegated
  agent can call before the global default-allow policy runs.
- Do not change Settings ownership of provider keys, OAuth, secrets, or accepted
  skill hashes.
- No migration/back-compat work. The app is pre-release; stale dev userData can
  be wiped or normalized.

## Design

### Shape

Shape **(a)**: one complete feature in one implementation PR. It changes the
permission evaluator, permission store, Security UI, log actions, tests, and
spec together. Shipping only the evaluator would leave users unable to correct
bad behavior; shipping only the UI would misrepresent the runtime.

### Mental model

The policy becomes:

```text
ALLOW       -> default for everything not blocked
SOFT BLOCK  -> built-in or user blocklist match; user may allow once/always
HARD BLOCK  -> tiny redline floor; no in-app override
```

There is no default `ask` outcome for agent tool calls.

The practical rule is:

- **Before execution:** block only the most dangerous actions, and make most
  blocks user-overridable.
- **During execution:** log every tool call, derived action kind, and result.
- **After execution:** let the user block repeat behavior directly from the log.

This matches the actual value of a novice approval prompt: approval is removed
because it does not add reliable judgment. The runtime keeps the checks that
must not depend on model judgment, but only the smallest redline remains
non-overridable.

### Built-in blocks: as small as possible

Built-in blocks should be reduced to the minimum set that protects novices from
catastrophic or obviously unintended outcomes. A built-in block is not the same
thing as a permanent ban:

- **soft built-in block**: default is block, but the user may allow once or
  always allow that exact boundary;
- **hard redline block**: no in-app override; the user can still do the action
  manually outside Tenon if they truly intend it.

Most built-in blocks should be soft. Hard redlines are for actions where an
in-app "allow" button would make Tenon a credential-exfiltration, payment, or
host-destruction launcher.

Recommended split:

**Hard redline, no in-app override**

- **credential exfiltration**: sensitive credential paths combined with network
  or opaque outward sinks;
- **permission self-modification**: agent attempts to alter its own permission
  rules through a tool call;
- **provider/secret store self-modification**: writes to provider credentials or
  secret stores;
- **payment / purchase**: any future payment action unless a separate
  product-owned payment confirmation flow exists;
- **host destruction**: root/home/whole-workdir recursive deletion, disk erase,
  raw disk overwrite, shutdown/reboot, recursive ownership or permission changes
  at filesystem root.

**Soft built-in block, user-overridable**

- **remote or decoded code execution**: `curl|wget ... | sh`, decode-and-pipe
  shell forms, and explicit `eval` / interpreter-eval forms that execute opaque
  generated code;
- **OS-level persistence / self-amplification**: writes to shell startup files,
  cron, LaunchAgents, systemd user units, and git internals that can persist or
  rewrite repository behavior (`.git/hooks/*`, `.git/config`, `.git/refs/**`,
  `.git/objects/**`).

Do **not** soft-block these by default:

- broad external publishes (`git push`, `gh pr create`, deploy commands,
  message sends). They default to allow, and users can block them from the log;
- ordinary shell command substitution (`$(...)` or backticks) when it is not
  combined with sensitive-path access, network exfiltration, remote-code pipes,
  or another redline/soft-block trigger.

Everything else defaults to allow, including:

- local file read/write/edit/delete inside the handed local area;
- local code execution such as Python, Node, shell scripts, build tools, test
  tools, and converters;
- network reads such as search/fetch;
- dependency installs;
- external CLI actions such as GitHub, git push, deploy commands, and message
  sends, unless the user has added a matching block rule or the action hits the
  built-in blocklist.

This is intentionally wider than the current consequence model. The safety bet
shifts from "interrupt before commits" to "model judgment + durable audit +
fast user blocklist correction."

### Fix heredoc and generated-artifact false blocks

The Fable 5 PPTX failure is the motivating bug:

- `python3 - <<'PY' ... PY` was a normal local artifact-generation command.
- The parser scanned the Python heredoc body as if it were shell.
- OOXML/Python lines were split into hundreds of fake shell segments.
- One fake empty segment became `hidden_exec`, so the runtime hard-blocked a
  harmless deck-generation workflow.

The implementation should parse static heredocs as a single outer shell command:

- classify the outer command (`python3`, `node`, `bash`, etc.);
- do not split the heredoc body on shell operators;
- still run whole-command redline/soft-block scans where the shell surface
  actually contains them;
- treat the heredoc body as local code execution, which defaults to allow unless
  a redline or soft-block rule is hit.

This parser fix is required even under default allow because redline and
soft-block rules must not be triggered by false shell segments inside ordinary
generated content.

### User blocklist

Extend the permission store from "remember grants" to "remember blocks" and
soft-block overrides:

```ts
interface AgentToolPermissionSettings {
  grants?: string[]; // legacy/read-only until removed
  blocks: string[];
  softBlockAllows: string[];
}
```

Block entries should be narrow and explainable:

```text
Command(git push origin main)
Command(npm publish)
Scope(write:/Users/me/Finance)
Scope(read:/Users/me/.ssh)
External(github:relixiaobo/lin-outliner)
Action(shell.dependency_install)
```

Recommended matching semantics:

- `Command(...)` blocks an exact normalized shell command or a command prefix
  selected from a log entry.
- `Scope(read:/path)` blocks reads under a path.
- `Scope(write:/path)` blocks writes under a path.
- `External(...)` blocks a specific remote/account/service target when the
  descriptor can derive one.
- `Action(...)` is an advanced/broad block for users who want to disable a whole
  action family.

Invalid or unsupported block strings become diagnostics. Diagnostics are shown
in Settings -> Security and ignored by the evaluator.

`softBlockAllows` stores user exits from built-in soft blocks. It must not apply
to hard redlines. It uses the same narrow rule grammar as blocks:

```text
Command(curl https://example.com/install.sh | sh)
Scope(write:/Users/me/Library/LaunchAgents/example.plist)
Action(shell.remote_code_pipe)
```

For user-created block rules, "always allow" removes the matching user block
rather than adding a contradictory allow. For built-in soft blocks, it adds a
narrow `softBlockAllows` exception.

### Soft-block interruption UI

Default allow should remove ordinary approval prompts, but a soft-block hit
needs an explicit user exit. The UI should render a compact interruption card
with these actions:

- **Allow once**: execute this tool call once, record the override in the log,
  do not persist a rule.
- **Always allow**: for a user block, remove that block; for a built-in soft
  block, persist a narrow `softBlockAllows` exception.
- **Block now**: stop the tool call immediately.

The card should default to safe inactivity:

- show a short countdown;
- if the user does nothing, resolve as blocked when the countdown expires;
- clicking **Block now** resolves immediately;
- the countdown length should be long enough to notice but short enough not to
  stall the agent indefinitely.

This is deliberately different from today's approval card. It appears only when
the action has already matched a block rule. Normal local work never asks.

### Log-first correction UI

The runtime already persists and renders execution events:

- `tool_call.started`
- `tool_call.completed`
- `tool_result.created`
- `tool.permission.checked`
- `tool.permission.resolved`
- `approval.requested`
- `approval.resolved`

The implementation should build on this existing log rather than invent a new
history surface.

Add contextual log actions on tool-call / permission rows:

- **Block this exact command**
- **Block writes to this folder**
- **Block reads from this folder**
- **Block this external target**
- **Block this action kind**

Only show actions that the descriptor can support. For example, a shell command
with no derived path should offer command/action blocks, not a fake folder
block. A blocked item should show a small "Blocked by your rule" state on future
log entries.

For soft-blocked built-in behavior, future log entries should distinguish
"blocked by Tenon default" from "blocked by your rule" so users understand
whether **Always allow** removes their own block or creates a default-block
exception.

This converts the log into the user's correction mechanism: let the agent work,
then let the user say "never do this again" from the concrete thing they saw.

### Settings -> Security

Simplify Security around the new model:

- show one "Default allow" delegated-operator row;
- list built-in soft blocks and user-created "always allow" exceptions;
- list the tiny hard redline as read-only "Always blocked by Tenon";
- list user block rules with revoke buttons;
- keep accepted skill hashes and diagnostics;
- remove any UI that implies ordinary permission prompts are still the primary
  safety mechanism.

The page should avoid expert-only language where possible. The product truth is:

```text
Tenon lets agents act by default. Tenon blocks catastrophic actions. You can
block repeated behavior from the log. If Tenon blocks a risky action by default,
you can allow it once or always allow that narrow behavior.
```

### Runtime behavior

`evaluateAgentToolPermission` should resolve in this order:

1. derive descriptors and effects;
2. block hard redline descriptors;
3. apply the restricted skill/agent sandbox;
4. if a soft built-in block or user blocklist matches, return `soft_blocked`
   unless a matching `softBlockAllows` exception applies;
5. allow everything else.

The evaluator may still emit `tool.permission.checked` and
`tool.permission.resolved`, but the outcome vocabulary should reflect the new
shape:

- `allow` for default or non-matching blocklist;
- `soft_blocked` for user-overridable blocklist hits;
- `blocked` for hard redlines and expired/explicit soft-block denials.

There is no interactive `ask` state for ordinary permission. Existing approval
events remain for non-permission approvals such as skill trust and user
questions, and may remain in the schema for backward compatibility. Soft-block
interruptions can reuse the approval plumbing internally, but the product copy
should be "blocked by default; allow an exception" rather than "please approve
this ordinary action."

### File boundary

The plan deliberately widens policy decisions, but it should not silently erase
the real file-tool execution boundary without an explicit implementation choice.

Recommended first implementation:

- keep typed file tools constrained to workdir, scratch read roots, and handed
  folders;
- use `bash` for full local shell access where the user/model intentionally
  operates outside the typed file boundary;
- add user blocklist rules for paths/folders when the log shows unwanted access.

Reason: removing `resolveWorkspacePath` containment is a broader filesystem
contract change than replacing permission prompts. It can be revisited after the
default-allow policy lands.

### Telemetry and audit

Every allowed tool call should still record enough information to explain what
happened later:

- tool name;
- derived action kinds;
- command/path/external target summary;
- whether the decision came from default allow, built-in redline, restricted
  sandbox, built-in soft block, user blocklist, or soft-block exception;
- result summary and error state.

The log must be good enough for a user or reviewer to answer: "What did the
agent do, and how do I stop that kind of thing next time?"

## Files / Areas

Expected implementation touchpoints:

- `src/core/agentPermissionModel.ts` — decision vocabulary and action metadata.
- `src/main/agentPermissions.ts` — evaluator, redline/soft-block matching, heredoc parsing,
  blocklist matching.
- `src/main/agentToolPermissionRules.ts` — parse and serialize block rules.
- `src/main/agentToolPermissionStore.ts` — persist `blocks` and diagnostics.
- `src/main/agentRuntime.ts` / `src/main/agentSkillShell.ts` — remove ordinary
  permission approval path, keep hard-block notices.
- `src/core/agentEventLog.ts` and `src/main/agentDebugView.ts` if log rows need
  new block-action metadata.
- `src/renderer/ui/agent/AgentDebugPanel.tsx` — contextual "block this" actions
  from the execution log.
- `src/renderer/ui/agent/AgentSettingsView.tsx` — Security page copy and block
  rule management.
- `src/core/i18n/messages/en.ts` and `src/core/i18n/messages/zh-Hans.ts`.
- `tests/core/agentPermissions.test.ts` and
  `tests/core/agentRuntimeSkillsIntegration.test.ts`.
- `tests/renderer/*` for Security/log UI changes.
- `docs/spec/agent-tool-permissions.md` and
  `docs/spec/agent-event-log-rendering.md`.

Infrastructure ownership warning: this plan will touch permission/security
surface and `docs/spec/*`; implementation PR should request `/security-review`
and `/code-review ultra`.

## Collision Self-check

Open PR check at plan time:

- #251 `cc-2/conversational-agent-authoring` touches
  `docs/plans/conversational-agent-authoring.md` only.

No direct file overlap with this plan. The eventual implementation will touch
agent permission/security files and should be sequenced deliberately with any
future permission work.

## Risks

- **Model mistakes become real actions.** This is the core product tradeoff.
  The mitigation is a tiny redline, durable logs, and fast user block rules,
  not preflight prompts.
- **External mutations may surprise users.** Default allow includes external
  CLIs unless blocked. If that is too broad in review, the fallback is a very
  small "external publish/send" hard block, but that weakens the requested
  novice-friendly model.
- **Blocklist UX can become too technical.** The log action labels must be
  concrete ("Block this command") and hide raw rule strings unless the user opens
  details.
- **False hard blocks remain costly.** The heredoc parser fix and a broader
  generated-artifact corpus are required before the policy is usable.
- **Soft-block cards can drift back into approval fatigue.** Keep the built-in
  soft block set tiny; if users see these cards frequently, the model has
  reverted to prompt-driven permissions.
- **Unattended runs get more powerful.** Scheduled/background runs will no
  longer fail just because an action would have asked. They still need the hard
  redline and user blocklist. A soft-block hit in an unattended run should resolve
  as blocked after the same countdown policy, without waiting for user input.

## Open Questions

1. Should external world mutations such as `git push`, deploy, and message-send
   truly default to allow, or should they be the one remaining non-catastrophic
   block category?
   - Recommendation: default allow, because the user's stated product direction
     is "blacklist, not approvals." Let users add blocks from logs.
2. Should user blocklist rules support broad `Action(...)` blocks in the first
   PR?
   - Recommendation: yes, but hide them behind log/context menus and Settings
     details. They are useful for "never install dependencies" or "never deploy."
3. Should typed file tools eventually read/write outside workdir by default?
   - Recommendation: not in this PR. Keep the execution boundary stable and use
     shell for broader local operation until a separate filesystem contract plan
     exists.
4. What should happen to legacy grants?
   - Recommendation: parse them for diagnostics only, then normalize them away
     on next write. Default allow makes grants obsolete.
5. Which built-in blocks are hard redlines versus soft blocks?
   - Recommendation: keep the hard redline tiny: credential exfiltration,
     permission/provider/secret self-modification, payments without product
     flow, and root/home/disk/whole-workdir host destruction. Make remote-code
     pipes and persistence writes soft blocks with allow-once/always-allow exits.

## Implementation Checklist

- [ ] Add blocklist parsing, diagnostics, and persistence.
- [ ] Add `softBlockAllows` parsing, diagnostics, and persistence.
- [ ] Change permission evaluator from `allow | ask | deny` defaulting to
      `allow | soft_blocked | blocked`.
- [ ] Split built-in blocks into soft user-overridable blocks and tiny hard
      redlines.
- [ ] Add soft-block UI with allow once, always allow, block now, and countdown
      auto-block.
- [ ] Add static heredoc parsing so generated Python/Node artifacts do not
      create fake shell segments.
- [ ] Remove ordinary permission approval suspension from runtime tool calls.
- [ ] Add log row actions to create block rules from concrete executed behavior.
- [ ] Rebuild Settings -> Security around default allow + redline + soft blocks
      + user blocks.
- [ ] Update specs.
- [ ] Add core tests for default allow, redline, soft blocks, blocklist matching, heredoc
      commands, and restricted sandbox preservation.
- [ ] Add renderer tests for log block actions and Security block management.
