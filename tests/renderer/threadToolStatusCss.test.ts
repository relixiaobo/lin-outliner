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
      /\.thread-tool-failed > \.thread-tool-toggle \.thread-disclosure-status,\s*\.thread-tool-failed > \.thread-tool-toggle \.thread-tool-label,[\s\S]*?color:\s*var\(--status-danger\);/,
    );
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*\{[^}]*border-radius:\s*var\(--radius-pill\)/);
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*\{[^}]*background:/);
    expect(threadCss).not.toMatch(/\.thread-tool-failed[^{]*svg\s*\{[^}]*width:\s*9px/);
  });

  test('gives interrupted rows a muted treatment of their own', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-interrupted > \.thread-tool-toggle \.thread-disclosure-status,[\s\S]*?color:\s*var\(--text-faint\);/,
    );
  });

  test('scopes every status rule to the row own toggle so groups never restyle members', () => {
    for (const status of ['completed', 'failed', 'interrupted', 'inProgress']) {
      const unscoped = new RegExp(`\\.thread-tool-${status} \\.thread-`, 'g');
      expect(threadCss.match(unscoped)).toBeNull();
    }
  });

  test('spins only the running row own glyph, and stops under reduced motion', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-inProgress > \.thread-tool-toggle \.thread-disclosure-status svg,\s*\.thread-tool-inProgress > \.thread-tool-activity-toggle \.thread-disclosure-status svg \{\s*animation:\s*thread-tool-spin/,
    );
    const reducedMotion = threadCss.slice(threadCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('.thread-tool-inProgress > .thread-tool-toggle .thread-disclosure-status svg');
    expect(reducedMotion).toContain('.thread-tool-inProgress > .thread-tool-activity-toggle .thread-disclosure-status svg');
  });

  test('keeps a running row spinner visible through hover, focus, and expansion', () => {
    expect(threadCss).toMatch(
      /\.thread-tool-inProgress > \.thread-tool-toggle:hover \.thread-disclosure-status,[\s\S]*?\.is-expanded \.thread-disclosure-status \{\s*opacity:\s*1;/,
    );
    expect(threadCss).toMatch(
      /\.thread-tool-inProgress > \.thread-tool-toggle:hover \.thread-disclosure-chevron,[\s\S]*?\.is-expanded \.thread-disclosure-chevron \{\s*opacity:\s*0;/,
    );
  });
});
