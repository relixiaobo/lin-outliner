import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { WorkingText } from '../../src/renderer/ui/primitives/WorkingText';

const workingTextCss = await Bun.file('src/renderer/styles/working-text.css').text();
const tokensCss = await Bun.file('src/renderer/styles/tokens.css').text();

describe('WorkingText', () => {
  test('WorkingText renders one accessible text layer and an aria-hidden sweep copy', () => {
    const { document } = parseHTML(renderToStaticMarkup(
      <WorkingText aria-live="polite" className="context-copy" text="Running command" />,
    ));
    const root = document.querySelector('.working-text');
    const base = root?.querySelector('.working-text-base');
    const sweep = root?.querySelector('.working-text-sweep');
    const accessibleClone = root?.cloneNode(true) as Element | undefined;
    accessibleClone?.querySelectorAll('[aria-hidden="true"]').forEach((element) => element.remove());

    expect(root?.classList.contains('context-copy')).toBe(true);
    expect(root?.getAttribute('aria-live')).toBe('polite');
    expect(base?.textContent).toBe('Running command');
    expect(sweep?.getAttribute('aria-hidden')).toBe('true');
    expect(sweep?.querySelector('.working-text-sweep-copy')?.textContent).toBe('Running command');
    expect(accessibleClone?.textContent).toBe('Running command');
  });

  test('WorkingText mirrors truncation geometry and ellipsis onto its visual copy', () => {
    const html = renderToStaticMarkup(<WorkingText text="A long working label" truncate />);
    expect(html).toContain('working-text-truncate');
    expect(workingTextCss).toMatch(
      /\.working-text-truncate > \.working-text-base,\s*\.working-text-truncate > \.working-text-sweep > \.working-text-sweep-copy \{[^}]*width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(workingTextCss).toMatch(/\.working-text \{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s);
    expect(workingTextCss).toMatch(/\.working-text-sweep \{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/s);
  });

  test('WorkingText uses a cadenced tokenized sweep and becomes static for motion and contrast preferences', () => {
    expect(tokensCss).toContain('--working-text-highlight: rgb(var(--ink) / 0.72);');
    expect(tokensCss).toContain('--motion-working-cycle: 4s;');
    expect(tokensCss).toContain('--motion-working-delay: 600ms;');
    expect(tokensCss).not.toContain('--motion-working-stagger');
    expect(workingTextCss).toMatch(
      /animation:\s*working-text-sweep-window var\(--motion-working-cycle\) linear var\(--motion-working-delay\) infinite;/,
    );
    expect(workingTextCss).toMatch(/0% \{[^}]*animation-timing-function:\s*steps\(48, end\);/s);
    expect(workingTextCss).toMatch(/25%,\s*100% \{[^}]*transform:\s*translateX\(125%\);/s);
    expect(workingTextCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\), \(prefers-contrast: more\) \{\s*\.working-text-sweep \{\s*display:\s*none;/,
    );
  });
});
