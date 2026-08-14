# Action Registry

One object model and one action registry behind every surface that acts on
something Tenon can present. This document owns the object/action contracts,
the main-owned admission path, the action catalog, and the parameter candidate
policies.

Consumers today: the **node context menu**, which is a filtered, anchored view
of this registry. The searchable command surface is the second consumer and is
not built yet; the registry already carries its surface exposure so adding it
does not change the menu's set.

## The rule

**Every row or chip is an object; every action row is an action resolved for a
subject object.** Neither smuggles the other into a fused phrase. An object
name is a noun (*Today*, *Settings*), an action name is a verb (*Open*), and
`mainList` is deliberately not a valid `ActionSurface` — so "an action is never
a main-list row" is a type-level fact, not a convention.

## Where it runs

The registry, its object resolvers and its predicates live in `src/core/actions/`
and evaluate against exactly two things: the document projection, and the
main-owned invocation containing the objects the user can act on.

```txt
right-click
  -> InvocationSeed (renderer FACTS, sender-checked)
  -> main validates ids, derives facets, constructs objects, mints refs
  -> InvocationOpened { invocationRef, fixedItems, menuActions }
  -> the menu renders resolved ActionPresentations
  -> ActionRequest { actionId, invocationRef, subjectRef, arguments }
  -> main RE-EVALUATES, then produces and executes the effect plan
```

`ActionEffectPlan` only ever travels **main -> renderer**, the trusted
direction. A renderer may NAME an action; it may never author one.

Row applicability derives from the projection alone
(`core/actions/rowFacets.ts`): row kind, `stored`, `mutable` and the
`actionPolicy` ladder. The renderer's `SelectableRow` is these facets plus the
pane root, which only its keyboard-only outdent path reads.

## Objects

`SurfaceObject` has five arms: `node`, `nodeSelection`, `externalPage`, `draft`
and `appSurface`. There is deliberately **no `command` arm** in this release —
*Open main window* and *Open Settings* are app-surface objects plus `open`.

A node object carries three facets, and they preserve ONE object rather than
three rows:

| Facet | Used by | Ordinary node | Reference row | Field row |
| --- | --- | --- | --- | --- |
| `row` | duplicate / move / remove / restore | itself | the reference | the entry |
| `content` | done / tag / description / copy / agent | itself | the chain-resolved target | the entry |
| `canonicalSurface` | open / split / pin | itself | the chain-resolved target | the field **definition** |

Selection members keep the shipped **single-hop** content target; only the
anchored row resolves a reference chain. That asymmetry is shipped behaviour,
preserved deliberately.

## Invocation membership

An action subject is admissible only when its ref is in `fixedObjects` or in the
one `ready` result generation. Refs are generation-scoped: the same backing node
found twice receives a new `ObjectRef`.

Object-valued **arguments** use a separate membership domain. A candidate is
admissible only when its ref belongs to a `ready` generation whose slot matches
the request's `(actionId, subjectRef, parameterId)` exactly. This is why the
same node may hold a subject ref and a destination ref at once: the noun is the
same, the two refs grant different uses. Cross-slot and prior-generation refs
return `stale`, never accepted by backing identity.

`view` (panel id, visual row id, `rowExpanded`) and `workspace` (`isPinned`) are
**attested** by the main renderer and tied to the object they qualify. An action
that needs one resolves `absent` where it does not exist — that is why *Pin*,
*Show/Hide view toolbar* and *Edit filters/sorting/grouping/displayed fields*
have no row without a workspace or a view, while *Open in split pane* consumes
neither and stays available.

## Renderer capabilities

Two windows reach the seam and they are not equally trusted.

The launcher window gets a narrow bridge (`src/preload/launcher.ts`): the
generic `window.lin.invoke` surface is never exposed to it, and the page cannot
re-run the preload, so it cannot reach an API it was not given.

That module is built into the ONE preload bundle and selected by a role flag
main passes through `additionalArguments`. It is deliberately not a second
rollup entry: two entries emit a shared chunk that both bundles `require`, and a
sandboxed preload's `require` is a polyfill limited to
electron/events/timers/url — which left `window.lin` undefined in *every*
window while every test stayed green, because no renderer test loads a preload.
`tests/core/preloadBundle.test.ts` guards it.

Exposure is least privilege; it is not the gate.

The gate is `src/main/rendererCapabilities.ts`: capabilities are registered
against the real `webContents` at window creation and dropped when it is
destroyed, and every inbound seam checks them. An unregistered renderer has
none and fails closed.

| Capability | Main window, Settings, provider config | Launcher |
| --- | --- | --- |
| `appCommands` (`lin:invoke`) | yes | **no** |
| `launcher` (`launcher:*`) | no | yes |
| `actionRequests` (name an action, query a parameter, report a lifecycle event) | yes | yes |
| `actionAttestation` (create an invocation from a seed) | yes | **no** |

`lin:invoke` checks `appCommands` **before dispatch**, so no command name —
`get_projection`, `delete_node`, or any other — is reachable from the launcher.
`actionRequests` is shared because its whole safety argument is that main
re-evaluates the named tuple itself against the latest projection. Attestation
is not shared, because `view` and `workspace` facts are the main renderer's to
state and a launcher attempt to supply them is rejected rather than merged.

## Phases and confirmation

`live -> confirming -> executing -> spent`. The invocation is **claimed on
entering `executing`, before step 0 is dispatched**, so a second submit against
a claimed record is rejected. Only a COMPLETED action spends it: a surface that
stays open after a failure must still be able to search and retry, and a spent
record makes that still-visible panel inert.

Confirmation is a **main-owned phase**, not a boolean a caller can assert, and
there is deliberately **no token**. Main raises its own native sheet, observes
the acceptance, revalidates the subject and arguments, and executes. A token
would put the deciding artefact back in the hands the sheet exists to bypass —
a compromised renderer that merely *receives* one can redeem it silently.

Two consequences the surfaces must honour:

- **A decline is `cancelled`, not `stale`.** It is a deliberate user decision,
  and reporting it as a failure puts an error banner on screen for doing exactly
  what was asked.
- **A missing sheet host is `stale`, not `cancelled`.** No host means no
  confirmation, so nothing runs — but the user never saw a sheet, so they are
  not told they cancelled one.

*Delete forever* and *Empty Trash* carry `confirm` today; both are outside
`Cmd+Z`'s reach, which is why they get a sheet at all.

## Effect plans

An action resolves to an ORDERED PLAN, because real actions cross executors:
on an ordinary node, `editViewSection` runs `set_view_toolbar_visible` and only
THEN reveals the toolbar and the requested section. Renderer steps are emitted
only after the preceding main step succeeded, and main waits for each ack — so a
failed renderer step stops the plan and surfaces as a failure rather than
silence. Search nodes instead resolve directly to the two renderer reveal steps:
their compact result-view band is always available and is not governed by the
ordinary toolbar flag, so opening a section must not create an invisible view
configuration write or undo entry.

`ACTION_BINDINGS` (`core/actions/bindings.ts`) is a `const` VALUE, not an
interface: TypeScript erases interfaces, so a codec or executor could not read
one and a second value-level copy would recreate the drift it prevents. It
declares which commands produce a bindable value **and the path it lives at**
(`['focus', 'nodeId']` — there is no `result.focusNodeId` anywhere), and the
exact argument paths that may hold a step reference. Which paths accept one is
an explicit allow-list because `NodeId` is literally `string`:
`create_capture.input.destinationParentId` is bindable while its sibling
`create_capture.input.title` is not.

`src/core/actions/bindingContract.check.ts` is the compile-time proof: each
forbidden shape carries a `@ts-expect-error`, so the contract fails the build in
both directions.

Commands still return `CommandResult.focus`; main forwards the last executed
command's hint in the execution result because the renderer no longer reads its
own command reply.

## The catalog

Nineteen families. Several presentations may share one `actionId` without
sharing an effect: the same user intent with a different target state,
direction, representation, selected parameter or row-policy consequence stays
one family, while a different interaction surface, provenance model,
irreversible boundary or confirmation contract is a different action.

| Family | Subject | Typed arguments / resolved variants |
| --- | --- | --- |
| `open` | node canonical surface, app surface | one meaning; `go` / `navigate` are search aliases, never ids |
| `openInSplitPane` | node canonical surface | none; separate because it changes the destination container |
| `setPinned` | node + attested workspace facts | `pinned: true \| false` -> *Pin* / *Unpin* |
| `sendToAgent` | node content, external page | stages the object plus the current draft text |
| `duplicate` | node row or selection rows | none |
| `move` | node row or selection rows | relative `up` / `down`, or a destination node object |
| `setDone` | node content or selection contents | `done: true \| false` -> *Mark done* / *Mark not done* |
| `addTag` | node content or selection contents | tag object, or a tag draft resolved as create-then-apply |
| `setViewMode` | node content | `outline \| table` |
| `setViewToolbarVisible` | node content + attested view facts | `visible: true \| false` |
| `editViewSection` | node content + attested view facts | `filter \| sort \| group \| display` |
| `editDescription` | node content | none; an empty description is still edited |
| `copy` | node content | `text \| nodeId` |
| `remove` | node row or selection rows | no renderer-chosen mode; row policy resolves the variant |
| `restore` | trashed node row | none |
| `deleteForever` | trashed node row or selection rows | none; confirmed |
| `emptyTrash` | the Trash system node | none; confirmed |
| `capture` | external page | Today is a bound destination object; optional tag |
| `create` | node-purpose draft | Today is a bound destination object |
| `indent` | node row or selection rows | none; **searchable surface only** |
| `outdent` | node row or selection rows + attested pane root | none; **searchable surface only** |

There is no `run` family: this release has no genuine command object to run.

### Indent and Outdent are exposed, not inherited

They were keyboard-only, and exposing them was ratified as a declared addition
rather than allowed to fall out of the model. Three things had to be true:

- **A surface-exposure rule.** `ACTION_SURFACES` gives them `actionPanel` alone.
  Leaking them into the anchored menu would change that menu's set after its
  differential proof had already passed.
- **An attested pane root.** `outdent` is defined relative to the pane the user
  is looking at, and main cannot recover it — the same node appears under
  several roots. So `ViewFact.selectionRootId` is carried, and without it the
  action resolves **absent**, not rejected.
- **The shipped keyboard behaviour.** A command-only effect drops the selection
  restoration and expansion adjustment the keyboard path performs, and the loss
  is invisible until a user tries it. The plan therefore carries `outlineIntent`
  steps, and their ORDER is chosen per direction:

| Direction | Order | Why |
| --- | --- | --- |
| indent | expand target -> command | the target is about to gain children, so expanding it early moves nothing on screen |
| outdent | command -> collapse emptied | collapsing a parent that still holds the rows would hide them for a frame and then show them again one level out |

Selection restoration runs before the command in both (the ids survive), and
the plan sets `focus: 'surfaceOwned'` so the command's focus hint does not fight
the selection the intents just placed — the same reason the shipped keyboard
path passes `applyFocus: false`.

### `remove` names the intent; row policy chooses the effect

| Resolved row-policy set | Name | Effect plan |
| --- | --- | --- |
| ordinary row(s) only | *Move to Trash* | one `batch_trash_nodes` step |
| field-value row(s) only | *Remove field value(s)* | ordered `remove_field_value` steps |
| both kinds | *Remove selected items* | batch trash first, then field-value removals |

The policy is re-derived during evaluation and execution; it is never an
argument a renderer asserts. Calling the family `moveToTrash` would make the id
false for part of its accepted subject set — field values never enter Trash.

### No runtime toggles

The presentation records the desired END STATE and main re-evaluates that exact
state at execution time. A homogeneous subject presents only the state-changing
variant; a mixed selection presents both, and each changes only the nodes not
already in the requested state — so a mixed selection **converges** instead of
becoming a different mixed selection.

## Applicability has three states

- `absent` — no subject object of a supported kind: hidden. Opening a searchable
  action panel must not present a screen of things that cannot run.
- `rejected` — a subject exists but a predicate refuses it: shown with its
  reason in a searchable view, and mapped back to the shipped **disabled row**
  in the anchored menu.
- `applicable`.

One empty list collapses the first two and carries no reason either way.

## Naming

Every static object name, type label, action family and resolved variant has
reviewed copy in **both** locales (`core/i18n/messages/*`, under `actions`), and
search matches both at once regardless of the active UI language. User-authored
node, draft and page titles are `literal` names: they render exactly as captured
and are never translated.

An action label may name a fixed semantic boundary when that is what
distinguishes the operation (*Open in split pane*, *Move to Trash*, *Remove field
value*, *Empty Trash*, *Send to Agent*). It never interpolates the subject's
title.

## Candidate policies

What converges is the matching KERNEL, not the candidate policy
(`core/actions/candidates.ts`).

- **`Move to`** excludes the moving rows, field entries, descendants of the
  moving rows and Trash, and **admission runs before the limit**: filtering an
  already-limited generic result lets invalid descendants consume the limit and
  hide a valid ranked destination. An empty query has its own ordering rather
  than returning nothing. It runs in main, because the ranked kernel needs the
  live `TextSearchIndex` that the renderer's `DocumentIndex` does not carry —
  without it `searchEngine` falls back to a whole-phrase scorer and the
  difference is observable.
- **`Add tag`** admits tag definitions only, excludes already-applied tags,
  penalises hex-looking labels, and offers a **tag draft** as a noun row whose
  selection lets `addTag` resolve create-then-apply. There is no speculative
  top-level `createTag` action.

The at-caret `@` / `#` / `/` paths are **not** migrated onto this kernel; they
keep their typed domain policies, and moving them is separate work.

## Menu projection

The anchored menu walks `CONTEXT_MENU_ORDER` and resolves **one subject per
family** from the opening's object set, using the family's own accepted kinds.
With a live multi-selection, selection-capable families resolve once against the
selection while node-only families keep the anchored node. A naive object
flat-map would duplicate rows and change their subjects.

Separators fall where `MENU_GROUP` changes, so the view does not hard-code an
action sequence of its own. `setViewMode`'s two variants render as one *View as*
submenu parent.

Argument generations are deliberately excluded from the subject set: a
destination or tag candidate can fill only its declared slot and can never
become a menu subject by appearing there.
