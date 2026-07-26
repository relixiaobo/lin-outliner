# Office Ingestion And Inline Attachments

## Goal

Make attaching and reading a local presentation feel like one reliable workflow:
reject Office ownership files before they become misleading attachments, produce
a bounded structural text observation from large PPTX containers without relying
on host-installed Python or LibreOffice, and render every attachment at the
position where the user placed it in the composer.

## Non-goals

- Do not turn attachment paths or bytes into plain message text.
- Do not add editable Office content, page-perfect slide rendering, OCR, or image
  understanding to `file_read`.
- Do not install MarkItDown or another host tool on the user's behalf.
- Do not hide Office ownership files from raw Agent filesystem discovery such as
  `file_glob` or `bash`.
- Do not change the canonical `ThreadAttachmentContent` resource contract.

## Shape

This is shape (a): one complete feature in one PR. Office admission, PPTX
observation, transcript rendering, specifications, and regression coverage ship
together because they form one attach-send-read workflow.

## Design

### Office ownership files

A shared pure classifier recognizes Office ownership filenames such as `.~*` and
`~$*` only when they retain an Office document extension. Recent-file and local-
file search candidates omit them. Explicit picker, mention, paste, and drop
admission rejects them with a specific message and, when an exact sibling exists,
names that document without silently substituting it. `file_read` returns the
stable `temporary_office_file` error before extension-based converter discovery.
Raw filesystem tools remain complete and continue to show hidden files.

### Bounded PPTX observation

PPTX uses an in-process TypeScript reader backed by direct `yauzl` and `saxes`
dependencies. It lazily reads the ZIP central directory, validates the OOXML
content type and presentation parts, resolves canonical slide order, and streams
only selected XML entries. It extracts slide text, speaker-note text, and related
chart text where present. Media bytes, embedded packages, macros, scripts, and
external relationships are never opened. Transitional and Strict OOXML use
explicit namespace and relationship-type allowlists; every selected presentation,
slide, note, or chart target must also match its declared package content type
before the reader opens it.

Budgets apply to archive entries, selected uncompressed XML bytes, individual
parts, slide count, elapsed time, and final Markdown characters rather than the
container's total source length. Abort closes the archive and active streams.
Malformed signatures or missing required parts fail as `invalid_pptx` before any
MarkItDown probe. Empty-text slides remain visible in the observation with a
visual-content warning. The result identifies itself as structural PPTX text and
states that images, layout, and OCR were not observed. Existing MarkItDown routes
remain for the other supported rich-document formats.

### Ordered message rendering

The composer remains the ordering authority. Transcript rendering consumes the
canonical `ThreadUserContent[]` in sequence:

- text, Node references, directories, and every file attachment share an inline
  wrapping run, so an image keeps the same filename marker as another file;
- consecutive image attachments additionally form an external gallery immediately
  after their marker-bearing run and before a new inline run starts for following
  content; the preview never replaces canonical message content;
- multiple images and files preserve their submitted order during replay. Text
  editing is available only when canonical content contains at most one text
  part, so replacing that text cannot collapse attachment boundaries; split-text
  mixed messages remain immutable until a structured editor exists.

The inline file reference keeps the existing Thread-scoped preview identity and
does not add a second card wrapper inside the user-message surface. Galleries use
purpose-built one-, two-, three-, and four-image layouts. More than four images
start as four thumbnails with a compact bottom-right `+N` expansion control;
expanded galleries show every image and can be collapsed again. The count uses
the shared fixed-contrast media-HUD palette over arbitrary image pixels, but it
does not add file-preview blur or strong elevation. Rest, hover, active, and
keyboard-focus states stay visually distinct without changing tile geometry. A
tile still opens the shared reader.

### Dependencies and ownership

`package.json` and `bun.lock` declare the ZIP and SAX readers directly; relying on
Electron's transitive `yauzl` copy would make packaging accidental. No open PR
claims these files. PR #438 overlaps the transcript renderer, stylesheet, and
thread-rendering specification but not Office ingestion. It should land first;
this branch will rebase after that integration before becoming ready.

## Open Questions

None. The PM ratified the one-PR scope, the dependency change, exact attachment
ordering, inline markers for every file, and expandable image galleries outside
the message bubble.

## Verification

- Unit fixtures cover ownership-file classification, invalid and Strict OOXML,
  exact relationship types, selected-part content types, canonical slide order,
  notes/charts, media-heavy sparse containers, every archive budget, truncation,
  cancellation, and MarkItDown independence.
- Renderer tests cover file references before, between, and after text plus image
  blocks at the same canonical positions.
- Agent E2E covers rejecting an ownership file and sending a mixed attachment
  message. Light and dark screenshots cover desktop and narrow Agent rails.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, relevant
  `bun run test:e2e` targets, `bun run docs:check`, and `git diff --check`.
