import { describe, expect, test } from 'bun:test';

const runDetailCss = await Bun.file('src/renderer/styles/agent-run-detail.css').text();

describe('agent run row CSS', () => {
  test('separates child progress from the following summary chip', () => {
    expect(runDetailCss).toContain('.agent-run-branch-chip + .agent-run-meta-chip::before');
    expect(runDetailCss).toMatch(/\.agent-run-meta-chip \+ \.agent-run-meta-chip::before,\n\.agent-run-branch-chip \+ \.agent-run-meta-chip::before\s*\{[^}]*content:\s*"\\00b7";/s);
  });

  test('does not paint a card background on run row hover', () => {
    expect(runDetailCss).not.toMatch(/\.agent-run-row\.is-clickable:hover[\s\S]*?background\s*:/);
    expect(runDetailCss).not.toMatch(/\.agent-run-row\.is-clickable:focus-within[\s\S]*?background\s*:/);
    expect(runDetailCss).toMatch(/\.agent-run-row:hover \.agent-run-title,[\s\S]*?color:\s*var\(--text-strong\);/);
  });

  test('uses a native row cursor and visible drill-in affordance for clickable runs', () => {
    expect(runDetailCss).toMatch(/\.agent-run-row\.is-clickable\s*\{[^}]*cursor:\s*default;[^}]*user-select:\s*none;/s);
    expect(runDetailCss).toMatch(/\.agent-run-row\.is-clickable\s*\{[^}]*grid-template-columns:\s*var\(--checkbox-mark-size\) minmax\(0, 1fr\) var\(--control-size-sm\);/s);
    expect(runDetailCss).toMatch(/\.agent-run-open-affordance\s*\{[^}]*color:\s*var\(--text-faint\);[^}]*opacity:\s*0\.55;/s);
    expect(runDetailCss).toMatch(/\.agent-run-row:hover \.agent-run-open-affordance,[\s\S]*?opacity:\s*1;/);
  });

  test('animates live run status markers with the shared agent spinner', () => {
    expect(runDetailCss).toMatch(
      /\.agent-run-status-spinner\s*\{[^}]*animation:\s*agent-spin var\(--motion-spin-cycle\) linear infinite;/s,
    );
    expect(runDetailCss).not.toContain('agent-tool-spin');
  });

  test('keeps run list rows scannable with bounded titles and one-line metadata', () => {
    expect(runDetailCss).toMatch(/\.agent-run-list\s*\{[^}]*gap:\s*var\(--space-6\);/s);
    expect(runDetailCss).toMatch(/\.agent-run-row\s*\{[^}]*padding:\s*var\(--space-4\) 0 var\(--space-5\);/s);
    expect(runDetailCss).toMatch(/\.agent-run-title\s*\{[^}]*display:\s*-webkit-box;[^}]*overflow:\s*hidden;[^}]*-webkit-line-clamp:\s*2;/s);
    expect(runDetailCss).toMatch(/\.agent-run-meta-row\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow:\s*hidden;/s);
    expect(runDetailCss).toMatch(/\.agent-run-meta-chip\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  });
});
