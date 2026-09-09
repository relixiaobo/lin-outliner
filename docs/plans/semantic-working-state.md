# Settings Working States

**Shape:** (a) ONE complete user-visible feature in one PR.

## Goal

Apply the shipped `WorkingText` primitive to Settings operations that are
actively advancing. Provider validation/save and managed-Skill
install/update/uninstall/rollback should keep their command identity, use
truthful progressive copy, and settle into the existing success or failure
state.

The Thread/Plan working-state foundation already shipped in #531 and is current
spec authority. The Settings surface uses the single-window domain managers and
per-operation feedback from #656. This plan contains only the unimplemented
WorkingText consumer over those owners.

## Non-goals

- No change to `WorkingText`, its cadence, tokens, accessibility fallbacks, or
  Thread ownership rules.
- No spinner replacement for initial catalog/library loading, OAuth waiting,
  provider reconnect/backoff, or icon-only operations.
- No provider, managed-Skill, IPC, persistence, or permission behavior change.
- No new status vocabulary after an operation settles.

## Design

### Requirements

- **FR-1:** `WorkingText` is used only for an operation that is actively
  advancing and already has truthful progressive copy.
- **FR-2:** One operation owns at most one animated text surface.
- **FR-3:** Command identity glyphs remain stable from idle through working and
  settlement.
- **FR-4:** Waiting, recovery, initial loading, and terminal states remain
  outside the working treatment.

### Eligible operations

Use `WorkingText` only while these actions are actively executing:

- `ProviderConfigForm`: `Testing…` in the connection-test button and
  `Saving…` in the save action;
- `ManagedSkillsSettings`: `Resolving...`, `Installing...`, and `Applying...`;
  and
- managed-Skill reversal/destructive actions with explicit `Uninstalling...`
  and `Rolling back...` English and Simplified Chinese messages, published
  through `useManagedSkills` to the affected operation's feedback owner.

The visible command keeps its stable `AddIcon`, `RefreshIcon`, `TrashIcon`, or
`UndoIcon`; progress does not replace identity with `LoaderIcon`. Provider
validation has exactly one animated owner in its connection-test button. Keep
its result and retry interaction there instead of restoring a separate result
row. Skill feedback or disabled buttons may repeat the progressive label
statically but must not create a second moving copy.

### Retained states

The following stay on their current treatment:

- OAuth browser/person waiting;
- provider retry and reconnect recovery;
- initial provider, catalog, or Skill-library reads;
- completed, failed, unavailable, and validation-result states; and
- icon-only copy, refresh, and reveal actions with no stable text target.

`prefers-reduced-motion: reduce` and `prefers-contrast: more` retain the
progressive phrase as ordinary static text. Motion is supplementary and never
the only indication that the command is in progress.

### Ownership and verification

Expected product ownership is limited to `ManagedSkillsSettings`,
`useManagedSkills`, `ProviderConfigForm`, the English and Simplified Chinese
Agent settings message catalogs, focused renderer/E2E tests, and the current
Settings/Skill specs. The PR consumes the public `WorkingText` contract without
changing its component or CSS.

Automated evidence covers these test titles or their current equivalents:

- `validates a key asynchronously with one working owner and never saves on validate`;
- `keeps managed Skill action glyphs stable while progress copy is working`;
- `uses progressive uninstall and rollback copy while the mutation is pending`;
  and
- `keeps waiting recovery and resource loading outside WorkingText`.

Visual evidence covers light/dark, long English and Chinese copy, reduced
motion, increased contrast, and success/error settlement without layout shift.

## Acceptance Criteria

- **AC-1:** Provider validation/save and managed-Skill mutations show the
  specified progressive copy and settle into existing success/error states.
- **AC-2:** Provider validation has one animated owner in the connection-test
  button; repeated disabled-button copy is static.
- **AC-3:** Install/update/uninstall/rollback retain their action glyphs and do
  not substitute a loader glyph.
- **AC-4:** Reduced motion and increased contrast keep every working phrase
  readable and static while OAuth wait, recovery, and initial reads retain their
  prior treatment.

## Open questions

None. Eligibility, single-motion ownership, progressive copy, retained states,
and accessibility behavior are fixed by the shipped working-state contract.

## Implementation checklist

- [ ] Add progressive English and Simplified Chinese copy for every eligible
      provider and managed-Skill operation.
- [ ] Keep one `WorkingText` owner per operation and retain command glyphs.
- [ ] Update the current Settings and Agent Skill specs.
- [ ] Run typecheck, renderer tests, focused Settings E2E, docs checks, design
      guards, diff check, and light/dark accessibility verification.
