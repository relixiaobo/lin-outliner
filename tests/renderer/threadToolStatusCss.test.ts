import { describe, expect, test } from 'bun:test';

const threadCss = await Bun.file('src/renderer/styles/thread.css').text();

/**
 * Guards the tool-row status contract from `agent-run-presentation-consistency`:
 * status is colour on the row's own glyph and label, the shared indicator slot
 * geometry is never overridden, and every status selector is scoped to the row
 * that owns it so a group never restyles its members.
 */
describe('thread tool row status CSS guards', () => {
  test('tints failed rows instead of giving the status slot its own pill', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-failed > \.thread-tool-toggle \.thread-disclosure-status,\s*\.thread-tool-failed > \.thread-tool-toggle \.thread-tool-label \{\s*color:\s*var\(--status-danger\);/,
    );
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*\{[^}]*border-radius:\s*var\(--radius-pill\)/);
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*\{[^}]*background:/);
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*svg\s*\{[^}]*width:\s*9px/);
  });

  test('carries a failed outcome on the section heading that states it', () => {
    // The detail's one status colour belongs to the heading that names the
    // outcome. A whole-detail tint would repaint the arguments the tool was
    // given, which did not fail.
    expect(threadCss).toMatch(
      /\.thread-tool-section\.is-failed > header \{\s*color:\s*var\(--status-danger\);/,
    );
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*\.thread-tool-body[^{]*\{[^}]*color:/);
  });

  test('gives interrupted rows a muted treatment of their own', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-interrupted > \.thread-tool-toggle \.thread-disclosure-status,\s*\.thread-tool-interrupted > \.thread-tool-toggle \.thread-tool-label \{\s*color:\s*var\(--text-faint\);/,
    );
  });

  test('never lets a status tally be ellipsized away', () => {
    // The act shrinks; the outcome is pinned. Otherwise a narrow pane renders
    // "Changed config.json" for a row that actually failed.
    expect(threadCss).toMatch(
      /\.thread-tool-summary-act \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(threadCss).toMatch(
      /\.thread-tool-activity-count-failed,\s*\.thread-tool-activity-count-interrupted \{\s*flex:\s*0 0 auto;/,
    );
    // `nowrap` would let the flex item trim the " · " separator to zero width.
    expect(threadCss).toMatch(
      /\.thread-tool-activity-count-failed,[\s\S]*?white-space:\s*pre;/,
    );
    // The containers must be flex for the pin to hold.
    expect(threadCss).toMatch(
      /\.thread-tool-label,\s*\.thread-tool-activity-summary \{\s*display:\s*flex;/,
    );
  });

  test('colours only the tally in a group summary, never the whole line or its glyph', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-activity-count-failed \{\s*color:\s*var\(--status-danger\);/,
    );
    expect(threadCss).toMatch(
      /\.thread-tool-activity-count-interrupted \{\s*color:\s*var\(--text-faint\);/,
    );
    // A mixed-outcome group must not be painted wholesale by its worst member.
    for (const status of ['failed', 'interrupted']) {
      expect(threadCss).not.toContain(`.thread-tool-${status} > .thread-tool-activity-toggle`);
    }
  });

  test('scopes every status rule to the row own toggle so groups never restyle members', () => {
    for (const status of ['completed', 'failed', 'interrupted', 'inProgress']) {
      const unscoped = new RegExp(`\\.thread-tool-${status} \\.thread-`, 'g');
      expect(threadCss.match(unscoped)).toBeNull();
    }
  });

  test('uses metric-stable running colour as the static cue and never spins the semantic glyph', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-inProgress > \.thread-tool-toggle \.thread-tool-summary-act,\s*\.thread-tool-inProgress > \.thread-tool-activity-toggle \.thread-tool-summary-act \{\s*color:\s*var\(--text-strong\);/,
    );
    expect(threadCss).not.toMatch(/\.thread-tool-inProgress[^}]*font-weight:/s);
    expect(threadCss).not.toMatch(/\.thread-tool-inProgress[^{]*\.thread-disclosure-status svg\s*\{[^}]*animation:/);
  });

  test('reserves stable live elapsed geometry and one Turn motion owner', () => {
    expect(threadCss).toMatch(
      /\.thread-process-title-live \{\s*width:\s*100%;\s*font-variant-numeric:\s*tabular-nums;/,
    );
    expect(threadCss).toMatch(
      /\.thread-turn:has\(\.working-text\) \.thread-streaming-shape,\s*\.thread-turn:has\(\.working-text\) \.thread-streaming-shape path \{\s*animation:\s*none;/,
    );
    expect(threadCss).toMatch(
      /\.thread-turn:has\(\.thread-provider-retry\) \.working-text-sweep \{\s*display:\s*none;/,
    );
  });

  test('lets running rows use the ordinary disclosure glyph and chevron handoff', () => {
    expect(threadCss).not.toContain('.thread-tool-inProgress > .thread-tool-toggle:hover .thread-disclosure-status');
    expect(threadCss).not.toContain('.thread-tool-inProgress > .thread-tool-toggle:hover .thread-disclosure-chevron');
  });
});
