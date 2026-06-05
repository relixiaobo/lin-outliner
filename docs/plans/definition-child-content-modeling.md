---
status: shelved
priority: P2
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-05
---

> **Resolution (2026-06-05).** No model change. Prior art (Tana / nodex) and lin
> already converge on "options / template items are plain nodes referenced by id;
> no dedicated type" — option B is rejected as *more* machinery. The PM's actual
> complaint ("looks weird") was an **empty-state UX** gap, not a modelling one:
> an empty Default-content / Pre-determined-options block read as an orphaned
> label over a near-invisible ghost bullet. Fixed by adding an "add here"
> placeholder on the block's trailing draft (`Add default content…` /
> `Add an option…`) — see `outliner-parity-matrix.md` + `definition-config.spec.ts`.
> Shelved; reopen only if a concrete model pain (lost values on rename, per-option
> colour/order) actually appears.

# Definition child content: should Default Content / Pre-determined Options be a typed node?

Raised by the PM while reviewing the tag/field definition config pages: the
**"Default content"** block under a `tagDef`, and the **"Pre-determined
options"** block under an `options` `fieldDef`, both render as a plain sub-outliner
with an empty trailing bullet. Are these "essentially field nodes", i.e. should
they be a dedicated node type/structure rather than the definition node's loose
children?

This is a **protocol-surface question** (`src/core/types.ts` `NodeType`, the
config-as-nodes projection). It is recorded here for a GO/NO-GO; nothing ships
off this draft without ratification.

## Current model (what is true today)

- **Typed config** (Color, Extend from, Show-as-checkbox, Field type,
  Auto-collect, Hide field, …) is **not** loose children. It lives in a
  `defConfig` subtree and is read by `projectTagConfig` / `projectFieldConfig`
  (`src/core/configProjection.ts`). Each config row is a structured entry with a
  key + typed value (scalar / ref / ref-list). The picker rows you see are
  *virtual* rows derived from that subtree — already a "typed" model.
- **Default content** = a `tagDef`'s **own plain child nodes**. They are the
  template subtree cloned onto a node when this supertag is applied. Content is
  arbitrary (text rows, headings, even inline fields).
- **Pre-determined options** = an `options` `fieldDef`'s **own plain child
  nodes**, surfaced only when `fieldType === 'options'`
  (`definitionOutlinerLabel`, `src/renderer/ui/definition/definitionConfig.ts`).
  Instance values reference `systemOption` nodes (`enumListValues`,
  `configProjection.ts`); the option *catalog* shown here is just the def node's
  children.
- Both blocks are rendered by `NodePanel` as a normal outliner under a section
  label (`definitionTemplateLabel`, `NodePanel.tsx:171`). No dedicated node type
  backs the block itself — the section label is purely presentational.

So today: **config = typed nodes; default-content / options-catalog = untyped
children of the definition node.**

## The question, sharpened

These two blocks are not the same kind of thing, so answer them separately:

1. **Default content** is a *template* — by nature it must hold arbitrary content
   (any node type). Forcing it into a single "field node" would lose that. The
   real modelling gap (if any) is only that the template subtree has no explicit
   container node — it is implicit ("the def's direct children"). A dedicated
   `templateRoot` container node would make the boundary explicit and let a tag
   own *both* a template and (future) other child structure without ambiguity.
2. **Pre-determined options** is a *catalog of values*. Each item is conceptually
   a typed option, not free content. Modelling each as a dedicated node
   (`optionDef`/`systemOption`-like) — rather than a plain child whose text is the
   value — would: give options stable IDs (rename-safe references), allow
   per-option metadata (color, order, archived), and unify with the
   `systemOption` model instance values already point at.

## Reference implementations (what the prior art actually does)

Checked the two systems lin draws from. Both — and lin already — converge on the
**same** model: an option/template item is an ordinary node, identified by its
**node id**, with **no dedicated option node type**.

- **Tana.** "Everything is a node." A field's options are nodes; setting the
  field on an instance writes a **reference** to the chosen option node (stable
  id, rename-safe). Options are full nodes (can themselves be tagged / carry
  fields). No special "option type".
- **nodex** (`~/Coding/nodex`). Predetermined options are *"direct non-fieldDef,
  non-fieldEntry **children** of the fieldDef node"* — `resolveFieldOptions`
  (`src/lib/field-utils.ts:218`); the config row literally says *"Each node
  included will become an option"* (`field-utils.ts:368`). Both **Default
  content** and **Pre-determined options** are `control: 'outliner'` config
  sections (`field-utils.ts:528`, `:364`) — i.e. the def node's plain children.
  Options carry a stable id and optional `autoCollected` flag; **no option node
  type**.
- **lin (today)** already matches: the `options` fieldDef's children are the
  option pool; selecting one writes a **reference by id**
  (`selectFieldOptionDirect`, `src/core/core.ts:1617`), plus free-text values and
  autocollect. Default content = the tagDef's children.

## Options

- **A — Keep the current node model (recommended).** Options stay the def's plain
  child nodes, referenced by id. This is exactly Tana / nodex. Zero protocol
  churn. Stable identity is **already** provided by the node id — no rename-by-text
  problem when the value is a reference.
- **B — Add a dedicated option `NodeType`.** *Rejected.* It is **more** machinery
  than Tana, nodex, or lin currently use, and breaks the shared "everything is a
  node, identified by id" philosophy. The supposed payoff (stable identity,
  metadata) is already reachable on plain nodes — a node already has an id and can
  carry per-option fields/colour. A new type buys nothing the model lacks.

## Recommendation (for ratification)

**Do not add an option node type (reject B). Keep the current node model — it is
already the clean, prior-art-aligned design.** The PM's instinct ("should it be a
field node?") resolves to: it already *is* a node (referenced by id), which is
precisely how Tana and nodex do it; a special type would be a regression in
cleanliness.

If a concrete need appears, address it on the existing node model, no new type:

- **Per-option metadata** (colour / order / archived): options are already full
  nodes — attach config/fields to the option node directly.
- **Explicit template boundary** for Default content: only if the implicit "the
  def's direct children" boundary ever bites; a small `templateRoot` *container*
  (not an item type) would be the minimal move, separable from this question.

## Open questions

- Is there a concrete pain today (lost values on rename, duplicate options,
  needing per-option colour/order) — or is this purely a clean-model check?
  If it's the latter, this plan can close as **`shelved` / no-op** (current model
  already matches the prior art).
