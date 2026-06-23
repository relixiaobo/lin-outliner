# File Ingestion Runtime Follow-up

## Goal

Build a provider-neutral file ingestion layer for agent tools. Local paths remain
the way the model discovers files and calls `file_read`, but after that call the
runtime owns parsing, extraction, caching, paging, and provider adaptation.

The follow-up keeps the path-based workflow but makes runtime-derived text,
tables, manifests, and page images the canonical model input. Provider-native
document upload is not the PDF path: PDFs are processed locally into text and/or
images before the provider boundary so every model sees comparable content.

Shape: this is a set of independent complete features. Each feature ships as its
own PR and leaves the app better on its own.

## Non-goals

- Do not make file tools install system packages implicitly. Missing
  dependencies stay recoverable tool errors; the agent may use `bash` under the
  normal permission/audit path.
- Do not put raw base64 into model-visible JSON, persisted chat text, or debug
  summaries.
- Do not send raw PDF bytes to the model as the primary path, including
  provider-native PDF/file blocks or PDF base64. Text and image outputs are the
  primary representation.
- Do not require every provider to support native file blocks.
- Do not change `src/core/commands.ts` or `src/core/types.ts` for this plan
  unless a later feature explicitly becomes a coordinated protocol change.

## Design

### 1. Source payloads stay internal

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
This keeps the original file available to local extractors and caches without
making raw file upload the provider contract.

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

### 3. Provider adaptation consumes derived parts

Provider adapters consume `FileIngestionResult` and the target model capability:

| Capability | Preferred input |
|---|---|
| Image input | Extracted text plus selected rendered images |
| Text only | Extracted text, tables, manifests, and summaries |
| No useful rich input | Metadata plus instructions to request a narrower read |

Provider-native file upload is not canonical for PDFs and should stay disabled
unless a future feature explicitly opts into it after the same runtime-derived
fallback content exists. The runtime should always know the exact text/image
content the model receives.

Provider-native document support snapshot:

- OpenAI documents that file inputs can include PDFs and that PDF processing
  extracts both text and page images for vision-capable models:
  https://developers.openai.com/api/docs/guides/file-inputs
- Anthropic documents Claude PDF support for text, pictures, charts, and tables:
  https://docs.anthropic.com/en/docs/build-with-claude/pdf-support
- Gemini documents PDF processing through the Gemini API:
  https://ai.google.dev/gemini-api/docs/document-processing
- Mistral documents PDF/image OCR and document QnA flows:
  https://docs.mistral.ai/studio-api/document-processing/document_qna
- xAI documents uploaded files for document understanding:
  https://docs.x.ai/developers/files
- Perplexity documents PDF attachments by URL or base64:
  https://docs.perplexity.ai/docs/sonar/media

These capabilities are useful provider facts, but they are not portable enough
to be the ingestion contract.

### 4. PDF follow-up

Replace the provider-native PDF path with provider-neutral runtime extraction:

- Extract embedded text for the requested page range when possible with
  `pdftotext`; the default range is the full document.
- Render page images with Poppler only when the user asks for pages, the PDF has
  no useful text layer and is small enough to render inline, or the question
  needs layout/visual inspection.
- For large scanned PDFs, return page count metadata and instructions to call
  `file_read` with a page range instead of sending or rendering the whole PDF.
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
- Keep native file payloads out of the canonical path. Runtime-derived text,
  tables, and images must be sufficient before any provider-specific optimization
  is considered.

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
- selected provider path: extracted text, page images, tables, manifests, or
  metadata only
- truncation and recovery instructions

## Open questions

- Where should extraction caches live: per conversation payload directory, a
  shared content-addressed cache under agent data, or both?
- Should `file_read` expose a new `mode` option (`auto`, `text`, `pages`,
  `images`) or keep `pages` as the only explicit PDF selector?
- Do Office extraction features depend on bundled workspace dependencies, or do
  they keep using external conversion tools with recoverable install guidance?
- Should OCR/transcription be local-only, provider-backed, or deferred until a
  user explicitly asks for those capabilities?

## Build Checklist

- [ ] PDF runtime extraction PR: remove provider-native PDF payload conversion,
      extract full-document text by default, render explicit page ranges as
      images, and return large scanned PDFs as actionable metadata.
- [ ] Runtime representation PR: introduce `FileIngestionResult` internally and
      adapt current text/image/PDF paths onto it without changing behavior.
- [ ] Provider adaptation PR: move image/text/table/manifest selection behind
      one provider-capability function.
- [ ] Office extraction PR: implement `.docx`, `.pptx`, and `.xlsx` text/table
      extraction with bounded output and tests.
- [ ] Archive manifest PR: add safe archive listing without automatic recursive
      extraction.
- [ ] Debug visibility PR: show selected ingestion path and derived part counts
      without base64.
