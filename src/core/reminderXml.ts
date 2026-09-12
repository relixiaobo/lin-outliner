import type { ContextAuthority, ContextPurpose } from './agent/protocol';

// Shared XML escaping for the hidden reminder/briefing blocks the runtime injects. These
// blocks are pseudo-XML the model reads (not a strict parser target), so we escape the
// structural characters that could break a tag boundary while leaving prose readable.
// Apostrophes are intentionally left untouched — they are common in prose and need no
// escaping inside double-quoted attributes or element text.
//
// Lives in core (not main) so renderer-agnostic context builders and main-process
// reminder builders escape display names the same way.
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The exact provider-visible envelope, shared with context budget admission. */
export function renderContextReminder(blocks: readonly {
  readonly authority: ContextAuthority;
  readonly purpose: ContextPurpose;
  readonly body: string;
}[]): string {
  return [
    '<system-reminder>',
    ...blocks.flatMap((block) => [
      `<context authority="${block.authority}" purpose="${block.purpose}">`,
      escapeXml(block.body),
      '</context>',
    ]),
    '</system-reminder>',
  ].join('\n');
}
