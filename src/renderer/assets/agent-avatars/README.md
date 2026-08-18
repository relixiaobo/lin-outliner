# Agent portraits

One SVG per avatar key (`<key>.svg`), resolved at build time by
`src/renderer/agent/agentIdentity.ts` and inlined into the speaker header.
An identity with no `avatar` key — every custom Role until someone picks one —
falls back to the initial disc in `agentAvatarColor.ts` instead.

The default roster: `beaver` (Aspen), `fox` (Rena), `owl` (Ada), `bear`
(Bruno).

## The rule that keeps the set legible

**A portrait names the KIND; the persona names the ONE.** They must not say the
same thing. A bear face signed `Bear` adds nothing the face already said, so the
word reads as a caption instead of as somebody speaking — which is exactly how
it felt in the running app. Three layers, no overlap:

| layer | answers | example |
|---|---|---|
| portrait | which kind is this, at a glance | 🐻 a bear |
| persona | who is speaking, and what to call them | Bruno |
| Agent type | which agent exactly, for configuration | `general-purpose` |

The roster: **Aspen** (beaver) is the conversation's own agent — the one the
reader talks to — and the helpers she dispatches are **Rena** (fox,
`explore`), **Ada** (owl, `plan`), and **Bruno** (bear, `general-purpose`).
Aspen, Rena and Ada are drawn as female characters, Bruno as male — worth
keeping if these are ever redrawn, since the names are staying.

The product's name is not among them, deliberately: a transcript names the
participants in it, not the application they run inside. Aspen is a beaver
named for the tree beavers build with, which is the same joinery the product
is named for — the tie is in the world, not in the signature.

## Drawing constraints

These are read at **24px** in the transcript, circle-cropped by CSS. Everything
about the style follows from that size:

- 24×24 viewBox, drawn edge to edge — the parent does the cropping, so a full
  background square becomes the tile. The crop is a ROUNDED SQUARE
  (`--radius-sm` at the transcript's 28px), matching the identity tiles the
  settings surface already uses; only the four corners are shaved, so art may
  use the full square as long as nothing load-bearing sits in a corner.
- Flat shapes, no gradients, no strokes thinner than 0.5. One background hue,
  one warm off-white for the head (`#E9DDCE`), one shading tint (`#D6C4B0`),
  one near-black for features (`#2E251F`).
- **Muted, not vivid.** A flat field of saturated colour is the heaviest fill a
  box can have, and these sit in a rail where every other mark is neutral — at
  full saturation a 28px disc out-shouts the words beside it. The hues are
  pulled toward their own luminance so they read as identity without competing
  with the message. (Squaring the disc is not an alternative: a rounded square
  is ~26% more area than a circle in the same box, so it reads heavier, not
  lighter. The lever is saturation.)
- **Silhouette carries the species**, because features vanish first: the fox's
  triangular ears, the owl's two huge eyes, the bear's round ears, the beaver's
  wide head and pair of incisors. Two animals that share a silhouette must not
  share a hue — beaver and bear are the pair to watch.
- Distinct background hues, muted enough to sit under text on both a light and
  a dark deck. They are not species colours; they are what tells four discs
  apart at a glance.

## Status

**These four are PLACEHOLDER art.** The PM is supplying the default roster;
when those land, replace the files here and nothing else changes — the shape,
size, and crop live in CSS, and the key→file mapping is the only contract. The
constraints below are what a replacement has to satisfy, not a description of
what must be kept.

## Provenance

Hand-authored for this repo (no vendored source, no image generation, no
network at runtime). Verify a change by rendering all four at 24/48/96px on
both a white and a near-black field before committing.

## Stability

**A regenerated portrait is a different face.** These are identity, and a
participant whose face changes is read as a different participant. Redraw only
on a deliberate, ratified art-direction change — never as a side effect of
touching something nearby.
