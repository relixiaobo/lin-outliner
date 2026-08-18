import { describe, expect, test } from 'bun:test';

const threadCss = await Bun.file('src/renderer/styles/thread.css').text();
const tokensCss = await Bun.file('src/renderer/styles/tokens.css').text();

/**
 * Guards the speaker header's column: a portrait in the margin, and every line
 * of the block — the name, the work line under it, and the words below —
 * hanging from ONE text edge. The two ways that column has already broken are
 * a box that pokes outside the block (a chord shaved off the portrait) and a
 * box that indents past it (a step in the middle of three lines), so both are
 * held here rather than left to a screenshot.
 */
describe('speaker header column CSS guards', () => {
  test('derives the text inset from the portrait and its gap, with nothing to compensate for', () => {
    expect(threadCss).toMatch(
      /--speaker-text-inset:\s*calc\(var\(--speaker-avatar-size\)\s*\+\s*var\(--space-4\)\);/,
    );
    expect(threadCss).toMatch(/\.thread-speaker-content \{[^}]*padding-left:\s*var\(--speaker-text-inset\);/);
  });

  test('keeps the portrait inside the block box, and round', () => {
    const avatar = threadCss.match(/\.thread-speaker-avatar \{[^}]*\}/)?.[0] ?? '';
    expect(avatar).toContain('aspect-ratio: 1;');
    // A negative inline margin put the disc outside its own block, where an
    // ancestor clipped a flat edge onto it.
    expect(avatar).not.toMatch(/margin-left:\s*calc\(var\(--space-1\)\s*\*\s*-1\)/);
    expect(avatar).toContain('overflow: hidden;');
  });

  test('lands the work line on the same edge as the name it sits under', () => {
    // It is a <button>, so without this it wears the UA's inline padding and
    // steps 6px right of the column — invisible while it sat beside the name.
    expect(threadCss).toMatch(/\.thread-speaker-meta \{[^}]*padding:\s*0;/);
  });

  test('gives the header exactly one anchor', () => {
    // The persona carries the emphasis; the type beside it and the work line
    // below share one quieter level. Three separate greys read as three loose
    // fragments and grouped against the header's own meaning.
    const name = threadCss.match(/\.thread-speaker-name \{[^}]*\}/)?.[0] ?? '';
    expect(name).toContain('color: var(--text-primary);');
    expect(name).toContain('font-weight: 650;');
    const role = threadCss.match(/\.thread-speaker-role \{[^}]*\}/)?.[0] ?? '';
    expect(role).toContain('color: var(--text-secondary);');
  });

  test('sizes the portrait to anchor the header, the way every IM does', () => {
    // Against ~18px lines: Slack 36, Discord 40, WeChat/Telegram 40, iMessage
    // 28. A disc scaled to ONE line leaves the line under it dangling.
    expect(tokensCss).toMatch(/--speaker-avatar-size:\s*32px;/);
    expect(threadCss).toMatch(/\.thread-speaker-header \{[^}]*align-items:\s*center;/);
  });
});
