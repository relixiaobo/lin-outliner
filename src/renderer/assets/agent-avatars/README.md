# Agent portraits

One image per avatar key (`<key>.png`), resolved at build time by
`src/renderer/agent/agentPortraits.ts` and rendered as an `<img>` in the speaker
header. An identity with no `avatar` key — every custom Role until someone picks
one — falls back to the initial disc in `agentAvatarColor.ts` instead.

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

## What a replacement has to satisfy

The tile renders at **28px**, cropped to `--radius-sm` and framed by an inset
hairline. Everything else follows from that size:

- **Square, full-bleed.** The image fills the tile (`object-fit: cover`), so
  anything not 1:1 is cropped by the browser rather than letterboxed, and the
  four corners are shaved by the radius — nothing load-bearing belongs there.
  No transparency needed.
- **128×128 PNG.** Covers 3× at tile size with room for the larger places an
  identity may appear later. Source art can be any size; downscale with a good
  filter (Lanczos) rather than shipping the master — a 1024px original is ~2 MB,
  which does not belong in a bundle.
- **Legible at 28px.** What survives at tile size is the silhouette and the
  largest colour areas; fine detail does not. Two identities that share both are
  two identities the reader cannot tell apart — beaver and bear are the pair to
  watch.
- **Quiet against text.** These sit in a rail where every other mark is neutral,
  beside the words they are labelling. A tile that out-shouts the message is
  too saturated for this surface, whatever it looks like at full size.

The current set is a flat animal face filling the frame on a plain ground —
what a 28px tile actually renders. The two earlier cuts are the argument for
it: a full figure in a landscape shrank the character to a few pixels, and
painted head-and-shoulders art survived but lost its detail to the downscale.
A face built from a handful of shapes loses nothing. Grounds are plain colour
per identity, so the tile also reads as a colour before it reads as an animal.
The ground has no edge of its own, so the hairline on `.thread-speaker-avatar`
is what frames it on both a light and a dark panel.

## Provenance

Supplied by the PM as 1024px masters, downscaled to 128px for the bundle. No image generation at runtime, no network. Verify a
change by rendering all four at tile size on both a light and a near-black
field before committing.

## Stability

**A replaced portrait is a different face.** These are identity, and a
participant whose face changes is read as a different participant. Swap them
only on a deliberate, ratified art-direction change — the key→file mapping is
the only contract, so a swap is a file replacement with no code change.
