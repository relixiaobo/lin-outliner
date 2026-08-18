# Agent portraits

One SVG per avatar key (`<key>.svg`), resolved at build time by
`src/renderer/agent/agentIdentity.ts` and inlined into the speaker header.
An identity with no `avatar` key — every custom Role until someone picks one —
falls back to the initial disc in `agentAvatarColor.ts` instead.

The default roster: `beaver` (Tenon, the conversation's own agent), `fox`
(`explore`), `owl` (`plan`), `bear` (`general-purpose`).

## The rule that makes the set learnable

**The persona IS the animal.** What you see is what it is called, so a roster
needs no legend. Adding a portrait is adding an animal name to the roster, not
adding decoration to an existing one.

## Drawing constraints

These are read at **24px** in the transcript, circle-cropped by CSS. Everything
about the style follows from that size:

- 24×24 viewBox, drawn edge to edge — the parent does the cropping, so a full
  background square becomes the disc. Keep detail inside a radius of ~11 from
  centre or the crop eats it.
- Flat shapes, no gradients, no strokes thinner than 0.5. One background hue,
  one warm off-white for the head (`#F2E7DA`), one shading tint (`#E0CDB8`),
  one near-black for features (`#2E251F`).
- **Silhouette carries the species**, because features vanish first: the fox's
  triangular ears, the owl's two huge eyes, the bear's round ears, the beaver's
  wide head and pair of incisors. Two animals that share a silhouette must not
  share a hue — beaver and bear are the pair to watch.
- Distinct background hues, muted enough to sit under text on both a light and
  a dark deck. They are not species colours; they are what tells four discs
  apart at a glance.

## Provenance

Hand-authored for this repo (no vendored source, no image generation, no
network at runtime). Verify a change by rendering all four at 24/48/96px on
both a white and a near-black field before committing.

## Stability

**A regenerated portrait is a different face.** These are identity, and a
participant whose face changes is read as a different participant. Redraw only
on a deliberate, ratified art-direction change — never as a side effect of
touching something nearby.
