# Native link colour for clickable text

## Goal

Clickable text — external links, file references, and node references — must read
as *a link*, not as *an error*. Today they are painted with the brand rose
(`--accent`: `#f43f5e` light / `#ff5d76` dark), which sits a hue away from the
error red (`--status-danger`: `#e5484d`) and, at rest, carries no affordance other
than colour. Users mistake the red clickable text for an error state.

Decouple the link role from the brand rose and give it a fixed **native macOS
link blue** (`NSColor.linkColor`). Blue is the universally-understood "this is a
link, not a warning" signal, and it is what the platform itself uses for links.

## Non-goals

- **No functional-state change.** Selection, hover, active rows, and focus stay
  neutral (`--fill-*` + neutral focus ring) per B3. Adopting the *variable* system
  accent (`controlAccentColor` / CSS `AccentColor`) for selection/focus is a
  separate, deliberately deferred decision ("B"); this plan is "A" only.
- **No change to the brand rose itself.** Rose stays as the sparse brand accent —
  the text caret (`--caret`), the workspace-root avatar, and small status badges
  still use `--accent`.
- **No copy / i18n / layout change.** Colour only.
- **No new resting affordance.** Links keep the existing hover-only underline;
  blue alone resolves the "looks like an error" misread, and a resting underline
  on dense node-ref outlines would add visual noise. (Revisit only if a11y review
  asks for a non-colour cue.)

## Design

This is **shape (a): one complete feature in one PR.** A single token redefinition
fans out to every link surface through the existing token graph.

### The change

`--link` was `var(--accent)`. Repoint it to a fixed native link blue, with a
dark-mode override for legibility on dark ink:

| token | light | dark |
|---|---|---|
| `--link` | `#0a66d6` | `#4c9bff` |

Hex literals live in the token *declarations* (`tokens.css` / `theme-dark.css`),
which is the sanctioned place for raw hex (B1). Every downstream consumer already
rides `--link` and so inherits the blue automatically:

- `--inline-ref-default` / `--inline-ref-hover` → node & file references
  (`inline-ref.css`, `outliner.css`, `agent-message.css`)
- external markdown links (`agent-markdown.css`)
- provider doc links (`settings-providers.css`)
- backlinks navigation action (`panel.css`)

`--caret` keeps `var(--accent)` — the streaming caret stays brand rose.

### Why fixed, not the variable system accent

macOS uses two different system colours: `linkColor` (a **fixed** blue used for
hyperlinks, independent of the user's accent preference) and `controlAccentColor`
(the **user-variable** accent used for selection/focus/controls). Links are the
former, so a constant blue is both correct and native. Keeping it a constant also
means pure-CSS tokens with no renderer JS theme bridge (B2) and deterministic
guard tests.

### Files

- `src/renderer/styles/tokens.css` — `--link` → `#0a66d6`; comment updates.
- `src/renderer/styles/theme-dark.css` — `--link: #4c9bff` dark override.
- `docs/spec/design-system.md` — A6: rewrite the link rules (principle 3, the
  accent token block, "Brand accent is sparse" + a new link bullet, the status
  paragraph distinguishing `--status-info` from `--link`, and the inline-reference
  section). B3 is unchanged.

### Verification

`bun run typecheck` · `test:renderer` · `test:e2e` (relevant) · `docs:check`;
visual verification in **both** light and dark (links/refs read as blue links;
caret/avatar/badges stay rose; selection/focus still neutral). Exact blue values
tuned for contrast during the visual pass.

## Open questions

- None blocking. The light/dark blue values may be nudged during visual
  verification for AA contrast on each surface.
