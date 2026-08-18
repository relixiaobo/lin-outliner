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
  test('gives the message the whole column instead of an avatar lane', () => {
    // Documents, not chat bubbles: a table in this rail pays for every pixel an
    // indent would take. The header row is what marks a change of speaker.
    const content = threadCss.match(/\.thread-speaker-content \{[^}]*\}/)?.[0] ?? '';
    expect(content).not.toContain('padding-left');
    expect(threadCss).not.toContain('--speaker-text-inset');
  });

  test('gives the mark no frame — the form is its own edge', () => {
    const avatar = threadCss.match(/\.thread-speaker-avatar \{[^}]*\}/)?.[0] ?? '';
    expect(avatar).toContain('aspect-ratio: 1;');
    // The tile-and-frame treatment existed for raster portraits whose painted
    // grounds had no boundary of their own. A generated form needs none of it,
    // and reintroducing any of the three would put a box around a shape.
    expect(avatar).not.toContain('background');
    expect(avatar).not.toContain('border-radius');
    expect(avatar).not.toContain('box-shadow');
  });

  test('blinks asymmetrically and honors reduced motion', () => {
    // Fast shut, relaxed open — equal speeds read as a machine.
    expect(threadCss).toMatch(/\.agent-mark-eye \{[^}]*transition:\s*transform 150ms/);
    expect(threadCss).toMatch(/\.agent-mark-eye\.is-shut \{[^}]*transition:\s*transform 55ms/);
    expect(threadCss).toMatch(/prefers-reduced-motion[^}]*\{[^{]*\.agent-mark-eye/);
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
    // One step above the metadata sharing its lines — enough to anchor the
    // header without jumping a third over everything beside it.
    expect(name).toContain('font-size: var(--font-ui-sm);');
    const role = threadCss.match(/\.thread-speaker-role \{[^}]*\}/)?.[0] ?? '';
    expect(role).toContain('color: var(--text-secondary);');
  });

  test('sizes the portrait to anchor the header, the way every IM does', () => {
    // Against ~18px lines: Slack 36, Discord 40, WeChat/Telegram 40, iMessage
    // 28. A disc scaled to ONE line leaves the line under it dangling.
    expect(tokensCss).toMatch(/--speaker-avatar-size:\s*28px;/);
    expect(threadCss).toMatch(/\.thread-speaker-header \{[^}]*align-items:\s*center;/);
  });
});
