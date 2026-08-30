import { clipboardImageFiles } from './imagePaste';
import { dataTransferFiles } from './attachmentIngest';
import { detectSingleLineUrl } from './pasteParser';

/**
 * The "media / URL" front-matter of a paste — the part that the inline editor
 * (`RichTextEditor`) and the trailing input (`TrailingInput`) classify
 * identically. Whatever a node line should do with a pasted image, image URL,
 * or link belongs here so both editors stay in lock-step; only the *application*
 * of an intent (edit in place vs. create a node) differs between them.
 */
export type MediaPasteIntent =
  | { kind: 'files'; files: File[] }
  | { kind: 'images'; files: File[] }
  | { kind: 'bareUrl'; url: string }
  | { kind: 'linkUrl'; url: string };

/**
 * Classify the media/URL front-matter of a clipboard paste, or return `null`
 * when the clipboard is none of these (the caller then proceeds to its own
 * structured/plain-text handling).
 *
 * Order matches the inline editor and must not change without updating both
 * call sites:
 *
 * 1. Files — image-only clips keep the dedicated image intent; any mixed or
 *    non-image file clip becomes a Source-backed Node paste.
 * 2. A lone bare web URL with no selection or HTML anchor is eligible for the
 *    empty-node Source producer. The editor still decides whether its target is
 *    an empty ordinary Node.
 * 3. Every other single-line URL remains an inline link.
 *
 * Must run synchronously inside the paste event: `clipboardImageFiles` reads
 * `DataTransfer.items`, which is only valid during dispatch.
 */
export function classifyMediaPaste(
  data: DataTransfer | null | undefined,
  options: { hasSelection: boolean } = { hasSelection: false },
): MediaPasteIntent | null {
  const allFiles = dataTransferFiles(data);
  if (allFiles.length > 0) {
    // A real File payload wins over accompanying text: copied files should paste
    // as Source-backed Nodes even when the source app also places a display name on the clipboard.
    const imageFiles = allFiles.filter((file) => file.type.startsWith('image/'));
    return imageFiles.length === allFiles.length
      ? { kind: 'images', files: imageFiles }
      : { kind: 'files', files: allFiles };
  }

  const files = clipboardImageFiles(data);
  if (files.length > 0) return { kind: 'images', files };

  const plain = data?.getData('text/plain') ?? '';
  const linkUrl = detectSingleLineUrl(plain);
  if (linkUrl) {
    const html = data?.getData('text/html') ?? '';
    const carriesAnchor = /<a\b[^>]*\bhref\s*=/iu.test(html);
    return !options.hasSelection && !carriesAnchor
      ? { kind: 'bareUrl', url: linkUrl }
      : { kind: 'linkUrl', url: linkUrl };
  }

  return null;
}
