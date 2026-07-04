# Ask User Question Stepper

## Goal

Make `ask_user_question` use one interaction model: a stepper that shows one
question at a time.

When an agent asks multiple structured questions, the user should see only the
current question, answer it, then move to the next. The UI should preserve the
existing tool protocol and final result shape, but remove the current stacked
multi-question presentation.

## Non-goals

- Do not change the `ask_user_question` tool input or result contract.
- Do not lower or raise the current 1-4 question validation bound.
- Do not split one model tool call into multiple backend pending-question
  records.
- Do not add a second "batch form" mode for short or low-risk questions.
- Do not add a final review/summary step. The last question submits directly.
- Do not change permission approval cards or normal chat clarification behavior.
- Do not redesign the whole composer surface.

## Shape

This plan is shape (a): one complete feature in one PR.

It should ship as one vertical UI behavior change: renderer interaction,
validation behavior, i18n copy, visual styling, tests, and spec sync together.

## Objective, Constraints, And Options

- **OBJ-1:** Reduce user cognitive load when an agent asks multiple required
  decisions by making the user decide on exactly one question at a time.
- **Minimum acceptable outcome:** A multi-question `ask_user_question` request
  never renders multiple question bodies at once; the user can answer each
  question sequentially, go back, and submit the unchanged structured result at
  the end.
- **Clean-slate best answer:** Structured user elicitation is always a
  conversational stepper, not a form. The surface has one active decision,
  progress, forward/back navigation, and one final submission.
- **Selected target:** OPT-2 because it preserves the existing backend event
  model and tool contract while fixing the user-facing interaction.

### Constraints

- **CON-1 hard:** The persisted `user_question.requested` and
  `user_question.answered` event shapes remain unchanged in this PR.
- **CON-2 hard:** The model-visible tool result remains one
  `AskUserQuestionResult` containing answers keyed by all requested question ids.
- **CON-3 hard:** "Discuss first" remains a whole-request escape hatch. It
  resolves the request with `outcome: "discussed"` and no partial answers.
- **CON-4 legacy:** `AgentUserQuestionCard` currently keeps a draft map keyed by
  question id and submits all answers at once.
- **CON-5 legacy:** Rich answer behavior already supports text, node refs, file
  refs, and attachments; the stepper must not regress these capabilities.
- **CON-6 design-system:** The card stays inside the composer surface, uses
  existing neutral tokens, preserves focus-visible behavior, and must fit mobile
  and desktop widths without layout shift.

### Options

- **OPT-1 clean-slate:** Change the tool contract so the agent asks only one
  question per tool call.
  - **Rejected for now:** It would increase model/tool churn and lose the value
    of one structured request with related answers.
- **OPT-2 brownfield target:** Keep the request/result protocol, but render a
  client-side stepper that reveals one question at a time and submits once.
  - **Tradeoff TRD-1:** The UI stores partial answers locally until final
    submit, but backend persistence remains simple and compatible.
- **OPT-3 minimum acceptable:** Collapse later questions behind disclosure
  panels.
  - **Rejected:** It still exposes a multi-question form model and does not
    match the product decision to keep one clean interaction.

## Design

### Product Model

- **Request:** one pending `ask_user_question` request containing 1-4 questions.
- **Current question:** the one visible question at the active step index.
- **Draft answer:** local renderer state for each question id.
- **Step navigation:** user-visible movement between questions before final
  submission.
- **Final result:** the existing `AskUserQuestionResult` submitted once when the
  last question is answered.

### Flow

#### FLOW-1: Answer A Structured Question Request

- **Actor:** User.
- **Entry path:** The active run emits `user_question_request`, and the composer
  shows `AgentUserQuestionCard`.
- **Entry state:** A pending request has 1-4 normalized questions.
- **Goal:** Provide the required structured input without scanning several
  unrelated decisions at once.
- **Mainline:**
  1. The card opens on the first question.
  2. If the request has more than one question, the card shows progress such as
     "Question 1 of 3".
  3. The user answers the current question.
  4. The user clicks `Next` to move forward, or `Back` to revisit earlier
     answers.
  5. On the last question, the primary action uses the request's
     `submitLabel` when provided, otherwise the default submit copy.
  6. The card submits one `AskUserQuestionResult` with answers for all requested
     question ids.
- **Decision points:** answer selection/text/ref/attachment per question; back;
  discuss first.
- **Validation:** The current step cannot advance if that question is required
  and has no answer content. Optional questions may advance empty.
- **Result state:** The pending card closes after runtime resolution succeeds.
- **Failure/recovery:** If submission fails, keep the stepper and drafts in
  place, re-enable actions, and allow retry or discuss.
- **Requirements:** FR-1, FR-2, FR-3, FR-4.

#### FLOW-2: Discuss Before Answering

- **Actor:** User.
- **Entry path:** Any step in `AgentUserQuestionCard`.
- **Entry state:** A pending request is visible.
- **Goal:** Leave structured input and discuss in normal conversation.
- **Mainline:**
  1. The user clicks `Discuss first`.
  2. The UI resolves the whole request with `outcome: "discussed"`.
  3. The card closes and the agent receives the existing discuss instruction.
- **Decision points:** None after click.
- **Validation:** No per-question validation applies.
- **Result state:** No partial answers are submitted.
- **Failure/recovery:** If resolution fails, keep the card and drafts visible.
- **Requirements:** FR-5.

### Screen Behavior

#### SCREEN-1: Question Step Card

- **Purpose:** Let the user answer one pending structured question.
- **Entry:** FLOW-1 step 1.
- **Visible data:**
  - title: existing `Input needed` / localized equivalent;
  - progress text only when there is more than one question;
  - current question header, prompt, options, and rich-answer editor when
    applicable;
  - current question validation state through disabled `Next` / final submit.
- **Actions:**
  - `Back`: visible when current step index is greater than 0;
  - `Next`: visible before the last step;
  - final submit: visible on the last step, using `submitLabel` if supplied;
  - `Discuss first`: visible on every step.
- **States:**
  - single-question request: one step, no stacked list, no unnecessary back/next;
  - multi-question request: progress and step navigation;
  - required unanswered current question: forward/final action disabled;
  - optional unanswered current question: forward/final action enabled;
  - submitting: all actions disabled;
  - resolution failure: draft remains, actions re-enable.

## Requirements And Acceptance Criteria

- **FR-1:** Render one active question at a time.
  - **AC-1:** When a request contains more than one question, the card shall
    render only the current question's prompt/options/editor in the DOM-visible
    question area.
  - **AC-2:** When the user advances to the next question, the previous
    question's prompt/options/editor shall no longer be visible.

- **FR-2:** Preserve local draft state across navigation.
  - **AC-3:** When the user answers question 1, advances, goes back, and returns
    to question 1, the previous answer shall still be selected or present.
  - **AC-4:** When the user edits a previous answer and advances again, final
    submission shall use the edited value.

- **FR-3:** Gate navigation by the current question only.
  - **AC-5:** If the current question is required and unanswered, the `Next` or
    final submit action shall be disabled.
  - **AC-6:** If a future required question is unanswered, that shall not block
    moving from the current answered question to the next step.
  - **AC-7:** If the current question is optional and unanswered, the user shall
    be able to advance or submit.

- **FR-4:** Submit the existing structured result once at the end.
  - **AC-8:** When the final step is submitted, the renderer shall call
    `agent_resolve_user_question` once with one `AskUserQuestionResult`.
  - **AC-9:** The submitted result shall include an answer object for every
    requested question id, preserving selected options, text, node refs, file
    refs, and attachments.
  - **AC-10:** The backend/runtime normalization and validation shall not need a
    new event shape to accept the stepper result.

- **FR-5:** Keep discuss behavior whole-request and immediate.
  - **AC-11:** When the user clicks `Discuss first` on any step, the renderer
    shall submit `outcome: "discussed"` with `answers: []`.
  - **AC-12:** No partial step answers shall be included in a discuss result.

- **FR-6:** Keep the UI one-mode and accessible.
  - **AC-13:** The code shall not keep a batch multi-question rendering path.
  - **AC-14:** Step changes shall keep keyboard use coherent: focus moves to
    the next step's first useful control or prompt area, and focus-visible rings
    remain visible.
  - **AC-15:** The card shall pass the existing light/dark visual stability
    checks without overflow or token regressions.

## Suggested Implementation Boundaries

- `src/renderer/ui/agent/AgentComposer.tsx`
  - Refactor `AgentUserQuestionCard` from mapping all questions to one active
    `currentQuestion`.
  - Add `currentQuestionIndex` state, `goNext`, `goBack`, and
    current-question validation.
  - Keep the existing draft map by question id and the existing final result
    construction.
  - Keep `Discuss first` as a whole-request action.

- `src/renderer/styles/agent-composer.css`
  - Add compact progress/navigation styling using existing tokens.
  - Ensure no layout jump from step changes beyond content height naturally
    changing.

- `src/core/i18n/messages/en.ts` and `src/core/i18n/messages/zh-Hans.ts`
  - Add copy for `Next`, `Back`, and multi-question progress if needed.
  - Keep existing submit and discuss copy.

- `docs/spec/agent-tool-design.md`
  - Update the `ask_user_question` section to say multi-question requests render
    as a one-question-at-a-time stepper and still resolve once.

- Tests:
  - Update `tests/e2e/agent-composer.spec.ts` multi-question coverage to assert
    only one question is visible at a time, navigation preserves answers, and
    final submission includes all answers.
  - Preserve rich-answer and discuss tests.
  - Keep or adjust visual stability checks for light/dark.

## Risks

- **RISK-1:** Hidden drafts could be lost when moving between questions.
  - **Mitigation:** Keep the draft map keyed by question id and test back/forward
    edits.
- **RISK-2:** The final result could omit optional unanswered question ids.
  - **Mitigation:** Reuse the existing final answers mapping over
    `pendingQuestion.request.questions`.
- **RISK-3:** Focus may land awkwardly after step changes.
  - **Mitigation:** Add explicit focus behavior or testable focus target.
- **RISK-4:** Treating `Discuss first` as step-local would confuse the tool
  result.
  - **Mitigation:** Keep it whole-request and document this in spec/tests.

## Open Questions

- None. The product decision is settled: keep only the stepper interaction and
  remove the stacked multi-question presentation.

## Implementation Tasks

- [ ] 1. Refactor `AgentUserQuestionCard` to render one active question.
  - Covers FR-1, FR-2, FR-3.
  - Acceptance: AC-1 through AC-7.
  - Verification: renderer/e2e multi-question stepper tests.

- [ ] 2. Preserve final result construction and discuss behavior.
  - Covers FR-4, FR-5.
  - Acceptance: AC-8 through AC-12.
  - Verification: final submit and discuss tests.

- [ ] 3. Add stepper copy and styling.
  - Covers FR-6.
  - Acceptance: AC-13 through AC-15.
  - Verification: light/dark visual stability checks and i18n coverage.

- [ ] 4. Sync specs.
  - Covers all requirements.
  - Verification: `bun run docs:check`.

- [ ] 5. Run final validation.
  - Verification: `bun run typecheck`, relevant renderer/e2e tests,
    `bun run docs:check`, and `git diff --check`.
