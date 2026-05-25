import { clipboardImageFiles, imageUrlFromText } from './imagePaste';
import { detectSingleLineUrl } from './pasteParser';

/**
 * The "media / URL" front-matter of a paste — the part that the inline editor
 * (`RichTextEditor`) and the trailing input (`TrailingInput`) classify
 * identically. Whatever a node line should do with a pasted image, image URL,
 * or link belongs here so both editors stay in lock-step; only the *application*
 * of an intent (edit in place vs. create a node) differs between them.
 */
export type MediaPasteIntent =
  | { kind: 'images'; files: File[] }
  | { kind: 'mediaUrl'; url: string }
  | { kind: 'linkUrl'; url: string };

/**
 * Classify the media/URL front-matter of a clipboard paste, or return `null`
 * when the clipboard is none of these (the caller then proceeds to its own
 * structured/plain-text handling).
 *
 * Order matches the inline editor and must not change without updating both
 * call sites:
 *
 * 1. Image files (e.g. a screenshot) — take priority over text so a clipboard
 *    carrying both an image and its filename does not fall through to text.
 * 2. A lone remote image URL — only with no active selection. With a selection
 *    the URL should link the selected text instead, so it falls to `linkUrl`.
 * 3. Any single-line URL — becomes a link.
 *
 * Must run synchronously inside the paste event: `clipboardImageFiles` reads
 * `DataTransfer.items`, which is only valid during dispatch.
 */
export function classifyMediaPaste(
  data: DataTransfer | null | undefined,
  options: { hasSelection: boolean } = { hasSelection: false },
): MediaPasteIntent | null {
  const files = clipboardImageFiles(data);
  if (files.length > 0) return { kind: 'images', files };

  const plain = data?.getData('text/plain') ?? '';

  const imageUrl = imageUrlFromText(plain);
  if (imageUrl && !options.hasSelection) return { kind: 'mediaUrl', url: imageUrl };

  const linkUrl = detectSingleLineUrl(plain);
  if (linkUrl) return { kind: 'linkUrl', url: linkUrl };

  return null;
}
