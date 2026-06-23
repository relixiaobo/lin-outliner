# File Read Runtime

## Goal

Make `file_read` a single, provider-neutral file ingestion entry point. The
model still passes a local path, but the runtime owns representation selection:
plain text, Markdown, page images, notebooks, or metadata. The model should not
choose parser modes or provider-specific file payloads.

Shape: this is one complete feature in one PR. The PR ships the runtime
boundary, provider-neutral PDF behavior, and a MarkItDown-backed Markdown
backend for rich non-PDF documents.

## Non-goals

- Do not expose a `mode` selector to the model. Runtime chooses the best
  representation from the file type, available tools, and bounded output rules.
- Do not make file tools install system packages implicitly. Missing
  dependencies stay recoverable tool errors; the agent may use `bash` under the
  normal permission/audit path and retry the same `file_read` call.
- Do not put raw base64 into model-visible JSON, persisted chat text, or debug
  summaries.
- Do not send raw PDF bytes to the model as the primary path, including
  provider-native PDF/file blocks or PDF base64. PDFs are converted to text,
  page images, or metadata by the runtime.
- Do not implement OCR in this PR. Scanned PDFs are handled by page-image
  rendering when the page range is bounded, or by metadata plus instructions to
  request pages.
- Do not change `src/core/commands.ts` or `src/core/types.ts`.

## Design

### 1. Keep the `file_read` schema small

`file_read` keeps the current selector surface:

```ts
interface FileReadParams {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}
```

`pages` is a range selector for PDF/page-like files, not a parser mode. The
runtime chooses the representation automatically.

### 2. Add an internal ingestion boundary

Introduce a main-process file ingestion module that returns compact tool-result
metadata plus provider-facing content parts:

```ts
FileIngestionOutput {
  data: FileReadData;
  content?: Array<TextPart | ImagePart>;
  status?: ToolStatus;
  instructions?: string;
}
```

This boundary is internal to main/runtime code. It does not become a core
command protocol, and it does not leak provider-specific payload JSON. For
runtime-ingested binary/rich formats, the model-visible JSON is metadata-only;
extracted bodies are attached as text or image content parts.

### 3. Runtime-owned routing

The runtime routes by file type:

| File family | Runtime behavior |
|---|---|
| Text/code/Markdown/logs | Existing bounded text path with freshness tracking. |
| JSON/CSV/XML | Text first when small and readable; rich Markdown can be introduced later if needed. |
| Images | Existing image block plus dimensions; image base64 stays out of model-visible JSON. |
| PDF | Existing fast PDF path: `pdfinfo` + `pdftotext`; explicit `pages` renders JPEG page images; large scanned PDFs return metadata plus instructions to request pages. |
| Notebooks | Existing compact `.ipynb` parser. |
| Rich non-PDF documents | MarkItDown converts to bounded Markdown. |
| Unsupported binary | Recoverable error with supported formats and next steps. |

### 4. MarkItDown backend

MarkItDown is the default rich-document Markdown backend for non-PDF formats:

- `.docx`
- `.pptx`
- `.xlsx`
- `.xls`
- `.html`
- `.htm`
- `.epub`

The backend is external and optional. Probe order:

1. `LIN_AGENT_MARKITDOWN_COMMAND`
2. `markitdown`
3. `python3 -m markitdown`

The runtime disables plugins and does not configure LLM or cloud backends. It
passes only local file paths that have already passed workspace containment.

If MarkItDown is missing, `file_read` returns a recoverable error that explains
how to install a minimal local backend, for example:

```bash
python3 -m pip install 'markitdown[docx,pptx,xlsx,xls]'
```

or a `uv` equivalent when available. The tool does not assume Homebrew and does
not install the package itself.

### 5. Bounded Markdown output

MarkItDown output is attached as a model-visible text part with a fixed character
cap. The JSON projection stays metadata-only. If the output is truncated, the
envelope status is `partial`, and the runtime data records the converter,
format, content length, and truncation flag. The full Markdown can be persistent
tool output in a later caching PR, but this PR keeps model-visible content
bounded.

### 6. Provider-native document support is not the contract

Several providers support native PDF or document inputs:

- OpenAI file inputs can include PDFs and extract both text and page images:
  https://developers.openai.com/api/docs/guides/file-inputs
- Anthropic documents Claude PDF support:
  https://docs.anthropic.com/en/docs/build-with-claude/pdf-support
- Gemini documents PDF processing:
  https://ai.google.dev/gemini-api/docs/document-processing
- Mistral documents OCR and document QnA:
  https://docs.mistral.ai/studio-api/document-processing/document_qna
- xAI documents uploaded files:
  https://docs.x.ai/developers/files
- Perplexity documents PDF attachments:
  https://docs.perplexity.ai/docs/sonar/media

These capabilities are useful provider facts, but they are not portable enough
to be the ingestion contract. Runtime-derived text, Markdown, and images remain
the canonical path.

## Build Order

- Add `src/main/agentFileIngestion.ts` with the rich-document Markdown backend
  and shared ingestion output types.
- Route rich non-PDF documents from `file_read` through MarkItDown.
- Keep PDF fast text/page-image behavior from the current PR and rename PDF
  helper terminology away from model-specific names.
- Add stable tests with a fake MarkItDown command so CI does not depend on a
  Python package install.
- Update `docs/spec/agent-tool-design.md` and `docs/spec/agent-progress.md` to
  describe runtime-owned representation selection.

## Future Work

- Cache derived file representations by source hash, extractor id, extractor
  version, and options.
- Add Docling as an optional structured backend for complex reading order,
  tables, and layout-heavy documents.
- Add OCR backends only after the runtime boundary and caching are stable.
