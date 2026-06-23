# File Ingestion Runtime Follow-up

## Goal

Build a provider-neutral file ingestion layer for agent tools. Local paths remain
the way the model discovers files and calls `file_read`, but after that call the
runtime owns parsing, extraction, caching, paging, and provider adaptation.

The PDF work in PR #322 is the first slice: it keeps the path-based workflow but
uses OpenAI Responses `input_file` only when the active provider supports native
PDF input. The follow-up turns that into a general file ingestion contract so all
models get a useful fallback, not just native-document models.

Shape: this is a set of independent complete features. Each feature ships as its
own PR and leaves the app better on its own.

## Non-goals

- Do not make file tools install system packages implicitly. Missing
  dependencies stay recoverable tool errors; the agent may use `bash` under the
  normal permission/audit path.
- Do not put raw base64 into model-visible JSON, persisted chat text, or debug
  summaries.
- Do not require every provider to support native file blocks. Text and image
  fallbacks must remain first-class.
- Do not change `src/core/commands.ts` or `src/core/types.ts` for this plan
  unless a later feature explicitly becomes a coordinated protocol change.

## Design

### 1. Source payloads are the source of truth

When a tool reads a binary or rich file, store the original bytes as a source
payload with stable metadata:

```
source payload
  id
  mimeType
  byteLength
  sha256
  summary
  display metadata
```

Derived representations reference the source payload and can be regenerated.
This keeps the original file available for provider-native paths while allowing
model-independent fallbacks.

### 2. Add a derived representation layer

Introduce a small internal model for extracted file representations:

```
FileIngestionResult {
  source: AgentPayloadRef
  kind: "pdf" | "image" | "office" | "notebook" | "audio" | "video" | "archive" | "text"
  metadata: Record<string, unknown>
  parts: FileIngestionPart[]
}

FileIngestionPart =
  | { type: "text"; text: string; page?: number; section?: string; truncated?: boolean }
  | { type: "image"; payload: AgentPayloadRef; page?: number; alt?: string }
  | { type: "table"; text: string; sheet?: string; range?: string; truncated?: boolean }
  | { type: "manifest"; text: string; truncated?: boolean }
```

This representation is not a core command protocol. It lives in main/runtime
code and feeds the agent provider boundary.

### 3. Provider adaptation happens last

Provider adapters consume `FileIngestionResult` and the target model capability:

| Capability | Preferred input |
|---|---|
| Native file/document input | Original source payload, size-capped |
| Image input | Extracted text plus selected rendered images |
| Text only | Extracted text, tables, manifests, and summaries |
| No useful rich input | Metadata plus instructions to request a narrower read |

Native file upload is an optimization, not the canonical representation. The
runtime should always know what fallback content the model would receive if the
native path is unavailable.

### 4. PDF follow-up

Extend the PR #322 PDF path with a provider-neutral fallback:

- Keep the native PDF raw-size cap before converting bytes to provider payloads.
  PR #322 uses a conservative 20 MB raw PDF cap because base64 expands by
  roughly one third.
- Extract embedded text per page when possible with `pdftotext`.
- Render page images with Poppler only when the user asks for pages, the PDF has
  no useful text layer, the question needs layout/visual inspection, or the
  provider cannot accept native PDFs.
- For large PDFs, return a page count, text availability summary, and
  instructions to call `file_read` with a page range instead of sending the whole
  PDF.
- Keep Poppler as an optional dependency with actionable recovery instructions.

### 5. Other file families

Text and code:
- Keep the existing bounded text read/freshness behavior.
- Treat markdown, JSON, CSV, and logs as text first, with specialized summaries
  only when needed.

Images:
- Keep dimensions and image blocks.
- Add optional OCR only as a later feature; do not block image reads on OCR.
- For non-vision models, expose metadata and a recoverable instruction that the
  model cannot visually inspect the image.

Office documents:
- Convert `.docx` to paragraphs and tables.
- Convert `.pptx` to slide text, speaker notes, and selected rendered slide
  images.
- Convert `.xlsx` to workbook metadata, sheet names, used ranges, and sampled
  tables.
- Keep native file payloads only as an optimization for models that support them.

Notebooks:
- Keep the current cell parser.
- Treat rich outputs as parts: text output, image payloads, and compact metadata.

Audio and video:
- Start with metadata only.
- Add transcript/key-frame extraction as independent later features.

Archives and directories:
- Never inline the whole archive.
- Produce a manifest with sizes, paths, and supported file counts.
- Let the agent choose specific files for follow-up `file_read` calls.

### 6. Caching and invalidation

Cache derived representations by source payload `sha256`, extractor version, and
options such as page range or text limit. If the source file changes, the source
payload hash changes and derived cache entries no longer match.

Do not cache provider-specific payload JSON. Cache model-neutral parts, then
adapt them per provider at request time.

### 7. Debugging and observability

The debug run should show the provider-facing result without dumping raw base64:

- source payload id, MIME type, byte length, and summary
- derived part counts by type
- selected provider path: native file, text fallback, images, or metadata only
- truncation and recovery instructions

## Open questions

- Where should extraction caches live: per conversation payload directory, a
  shared content-addressed cache under agent data, or both?
- Should the 20 MB PDF native cap become provider-configurable after more live
  provider validation?
- Should `file_read` expose a new `mode` option (`auto`, `text`, `pages`,
  `native`) or keep `pages` as the only explicit PDF selector?
- Do Office extraction features depend on bundled workspace dependencies, or do
  they keep using external conversion tools with recoverable install guidance?
- Should OCR/transcription be local-only, provider-backed, or deferred until a
  user explicitly asks for those capabilities?

## Build Checklist

- [ ] PDF fallback PR: add per-page text extraction fallback and large-PDF
      summary behavior on top of the current native size cap.
- [ ] Runtime representation PR: introduce `FileIngestionResult` internally and
      adapt current text/image/PDF paths onto it without changing behavior.
- [ ] Provider adaptation PR: move native PDF conversion and image/text fallback
      selection behind one provider-capability function.
- [ ] Office extraction PR: implement `.docx`, `.pptx`, and `.xlsx` text/table
      extraction with bounded output and tests.
- [ ] Archive manifest PR: add safe archive listing without automatic recursive
      extraction.
- [ ] Debug visibility PR: show selected ingestion path and derived part counts
      without base64.
