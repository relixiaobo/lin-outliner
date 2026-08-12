import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { WorkingText } from '../../src/renderer/ui/primitives/WorkingText';

const workingTextCss = await Bun.file('src/renderer/styles/working-text.css').text();
const tokensCss = await Bun.file('src/renderer/styles/tokens.css').text();

describe('WorkingText', () => {
  test('WorkingText renders one accessible animated text layer without a visual duplicate', () => {
    const { document } = parseHTML(renderToStaticMarkup(
      <WorkingText aria-live="polite" className="context-copy" text="Running command" />,
    ));
    const root = document.querySelector('.working-text');
    const base = root?.querySelector('.working-text-base');

    expect(root?.classList.contains('context-copy')).toBe(true);
    expect(root?.getAttribute('aria-live')).toBe('polite');
    expect(base?.textContent).toBe('Running command');
    expect(root?.textContent).toBe('Running command');
    expect(root?.querySelectorAll('.working-text-base')).toHaveLength(1);
    expect(root?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  test('WorkingText keeps truncation geometry and ellipsis on its animated text layer', () => {
    const html = renderToStaticMarkup(<WorkingText text="A long working label" truncate />);
    expect(html).toContain('working-text-truncate');
    expect(workingTextCss).toMatch(
      /\.working-text-truncate > \.working-text-base \{[^}]*width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(workingTextCss).toMatch(/\.working-text \{[^}]*position:\s*relative;[^}]*contain:\s*paint;[^}]*overflow:\s*hidden;/s);
  });

  test('WorkingText uses a cadenced tokenized sweep and becomes static for motion and contrast preferences', () => {
    expect(tokensCss).toContain('--working-text-highlight: color-mix(in srgb, currentColor 75%, rgb(var(--ink)) 25%);');
    expect(tokensCss).toContain('--motion-working-cycle: 2.4s;');
    expect(tokensCss).toContain('--motion-working-delay: 300ms;');
    expect(tokensCss).not.toContain('--motion-working-stagger');
    expect(workingTextCss).toMatch(
      /animation:\s*working-text-sweep var\(--motion-working-cycle\) linear var\(--motion-working-delay\) infinite;/,
    );
    expect(workingTextCss).not.toMatch(/steps\(/);
    expect(workingTextCss).toMatch(/60%,\s*100% \{[^}]*background-position:\s*250% 0;/s);
    expect(workingTextCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\), \(prefers-contrast: more\) \{\s*\.working-text-base \{[^}]*animation:\s*none;[^}]*background:\s*none;[^}]*-webkit-text-fill-color:\s*currentColor;/s,
    );
  });

  test('WorkingText confines animation to one paint-contained glyph layer without changing typography', () => {
    expect(workingTextCss).toMatch(
      /\.working-text-base \{[^}]*background-color:\s*currentColor;[^}]*background-image:[^}]*background-position:\s*-100% 0;[^}]*background-size:\s*50% 100%;[^}]*-webkit-background-clip:\s*text;[^}]*background-clip:\s*text;[^}]*-webkit-text-fill-color:\s*transparent;/s,
    );
    expect(workingTextCss).not.toMatch(/(?:^|\n)\.working-text-(?:sweep|sweep-copy)\s*\{/);
    expect(workingTextCss).not.toMatch(/(?:^|[;{]\s*)(?:-webkit-)?mask(?:-image)?\s*:/m);
    expect(workingTextCss).not.toMatch(/(?:^|[;{]\s*)transform\s*:/m);
    expect(workingTextCss).not.toMatch(/(?:^|[;{]\s*)font-(?:family|size|style|weight)\s*:/m);
    expect(workingTextCss).not.toContain('will-change');
  });
});
