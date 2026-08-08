import { describe, expect, test } from 'bun:test';

const noticeCss = await Bun.file('src/renderer/styles/action-notice.css').text();
const threadCss = await Bun.file('src/renderer/styles/thread.css').text();

/**
 * Guards the anchor from `error-feedback-unification`. The reported bug was not
 * that the notice was ugly — it was that it sat in the agent dock's corner, so
 * an outliner failure read as the agent failing. An anchor that drifts back to
 * either edge reintroduces exactly that, and it is invisible in review because
 * the notice still "looks fine" wherever it lands.
 */
describe('action notice anchor guards', () => {
  test('is centred on the window, owned by no column', () => {
    expect(noticeCss).toMatch(/\.action-notice \{[^}]*position:\s*fixed;/s);
    expect(noticeCss).toMatch(/\.action-notice \{[^}]*left:\s*50%;/s);
    expect(noticeCss).toMatch(/\.action-notice \{[^}]*transform:\s*translateX\(-50%\);/s);
  });

  test('never re-anchors to an edge a feature owns', () => {
    // The right edge is the agent dock's and the left is the sidebar's; the
    // bottom-right corner is where this started.
    expect(noticeCss).not.toMatch(/\.action-notice \{[^}]*(?:^|[^-])\bright:/s);
    expect(noticeCss).not.toMatch(/\.action-notice \{[^}]*(?:^|[^-])\bbottom:/s);
  });

  test('clears the chrome band the pane breadcrumb reaches into', () => {
    // Top-centre is the breadcrumb's; the notice starts below it rather than
    // covering the label that says which pane the failure came from.
    expect(noticeCss).toMatch(/\.action-notice \{[^}]*top:\s*calc\(var\(--chrome-height\)/s);
  });

  test('keeps the centring offset inside the entry animation', () => {
    // `transform` is animated, so a keyframe that forgets translateX(-50%)
    // parks the notice half a width off centre for the whole animation.
    const keyframes = /@keyframes action-notice-enter \{(.*?)\n\}/s.exec(noticeCss)?.[1] ?? '';
    expect(keyframes).not.toBe('');
    for (const step of keyframes.split(/\n\s*\n/)) {
      expect(step).toMatch(/translate(?:X)?\(-50%/);
    }
  });
});

describe('dock error strip guards', () => {
  test('states conditions without offering to dismiss them', () => {
    // A provider that is not configured cannot be acknowledged away, so this
    // strip has no close control — that is what separates it from the notice.
    expect(threadCss).toMatch(/\.thread-dock-error \{/);
    expect(noticeCss).toMatch(/\.action-notice-close/);
    expect(threadCss).not.toMatch(/\.thread-dock-error-close/);
  });
});
