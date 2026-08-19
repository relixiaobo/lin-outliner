import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  AWAKE_MARK_MOODS,
  MARK_MOODS,
  MARK_SILHOUETTE_RADIUS,
  markMoodParams,
  mixMarkParams,
  projectMarkEye,
  renderMarkEye,
  type MarkMood,
} from '../../src/renderer/agent/agentMarkGeometry';

const MOOD_KEYS = Object.keys(MARK_MOODS) as MarkMood[];

describe('agent mark animation loop', () => {
  test('survives a scheduler that calls back synchronously', async () => {
    // A synchronous rAF — a test shim, a polyfill — once re-entered the loop
    // from inside its own frame and recursed until the stack blew. Real rAF is
    // async, so guarding costs production nothing and turns an overflow into
    // "one frame, then still".
    const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const saved = ['document', 'window', 'HTMLElement', 'Node', 'Event'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    for (const [key] of saved) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: key === 'window' ? window : (window as unknown as Record<string, unknown>)[key],
      });
    }
    let frames = 0;
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames += 1;
      if (frames < 500) callback(frames);
      return frames;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      const { AgentMark } = await import('../../src/renderer/agent/components/AgentMark');
      const root = createRoot(document.getElementById('root')!);
      expect(() => act(() => root.render(<AgentMark mood="working" size={28} tint={4} />)))
        .not.toThrow();
      act(() => root.unmount());
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
});

describe('agent mark geometry', () => {
  test('keeps every eye inside the silhouette at every mood and pose', () => {
    // The bug this pins down: at an extreme turn the far eye once crossed the
    // face's outline, and a mask hole that crosses the outline reads as a bite
    // out of the face. Sweep every mood over the full pose envelope (beyond
    // what behaviour can request) and assert the stroke's box stays inside.
    let worst = 0;
    for (const mood of MOOD_KEYS) {
      const m = markMoodParams(mood);
      for (let yaw = -0.5; yaw <= 0.5; yaw += 0.1) {
        for (let pitch = -0.4; pitch <= 0.4; pitch += 0.1) {
          for (const sign of [-1, 1] as const) {
            const { px, py, fx } = projectMarkEye(m, yaw, pitch, sign);
            const uMax = Math.max(Math.abs(m.u1), Math.abs(m.u2), Math.abs(m.uc)) * m.grow;
            const vMax = Math.max(Math.abs(m.v1), Math.abs(m.v2), Math.abs(m.vc)) * m.grow;
            const halfW = uMax * fx + m.w / 2, halfH = vMax + m.w / 2;
            for (const [cx, cy] of [
              [px - halfW, py - halfH], [px + halfW, py - halfH],
              [px - halfW, py + halfH], [px + halfW, py + halfH],
            ]) {
              worst = Math.max(worst, Math.hypot(cx! - 16, cy! - 16));
            }
          }
        }
      }
    }
    expect(worst).toBeLessThan(MARK_SILHOUETTE_RADIUS);
  });

  test('narrows the far eye on a turn, the way a ball does', () => {
    const m = markMoodParams('idle');
    const far = projectMarkEye(m, 0.4, 0, 1);
    const near = projectMarkEye(m, 0.4, 0, -1);
    // Turning toward +yaw carries the right (far-side) eye toward the limb —
    // its foreshortening must undercut the near eye's, or the face is a disc.
    expect(far.fx).toBeLessThan(near.fx);
    expect(projectMarkEye(m, 0, 0, 1).fx).toBeCloseTo(1, 1);
  });

  test('a positive pitch looks DOWN: the eyes move down the screen', () => {
    const m = markMoodParams('idle');
    expect(projectMarkEye(m, 0, 0.3, 1).py).toBeGreaterThan(projectMarkEye(m, 0, 0, 1).py);
  });

  test('every mood renders a drawable stroke and distinct shapes', () => {
    const shapes = new Set<string>();
    for (const mood of MOOD_KEYS) {
      const eye = renderMarkEye(markMoodParams(mood), 0, 0, -1);
      expect(eye.d).toMatch(/^M[\d.-]+ [\d.-]+ Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/u);
      expect(eye.width).toBeGreaterThan(1);
      shapes.add(eye.d);
    }
    // Six moods, six silhouettes — a mood that renders like another is dead
    // weight in the vocabulary.
    expect(shapes.size).toBe(MOOD_KEYS.length);
  });

  test('moods morph: interpolation lands exactly on the endpoints', () => {
    const idle = markMoodParams('idle'), done = markMoodParams('done');
    expect(mixMarkParams(idle, done, 0)).toEqual(idle);
    expect(mixMarkParams(idle, done, 1)).toEqual(done);
    const mid = mixMarkParams(idle, done, 0.5);
    expect(mid.vc).toBeCloseTo((idle.vc + done.vc) / 2, 5);
  });

  test('a blink squashes the eye onto its anchor without moving it', () => {
    // Blinking is a rig PARAMETER, not a CSS scale on the mask group: a
    // transform there is the layout-free pop B7 refuses, and its timing would
    // be an untokenized motion literal. Closing must collapse the stroke
    // vertically while the anchor — the thing the pose positions — holds.
    const open = markMoodParams('idle');
    const shut = { ...open, openness: 0.02 };
    const a = renderMarkEye(open, 0, 0, -1), b = renderMarkEye(shut, 0, 0, -1);
    expect(b.originX).toBeCloseTo(a.originX, 6);
    expect(b.originY).toBeCloseTo(a.originY, 6);
    const height = (eye: { d: string }) => {
      const ys = [...eye.d.matchAll(/-?\d+\.\d+/g)].map(Number).filter((_, i) => i % 2 === 1);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(height(b)).toBeLessThan(height(a) * 0.2);
    // Stroke width is untouched: a closing eye becomes a line, not a dot.
    expect(b.width).toBeCloseTo(a.width, 6);
  });

  test('closed-eye moods are exactly the ones that do not blink', () => {
    // done/stopped/failed draw closed or near-closed eyes; a closed eye that
    // blinks is worse than one that never does.
    expect([...AWAKE_MARK_MOODS].sort()).toEqual(['idle', 'needsYou', 'working']);
    expect(MOOD_KEYS.filter((mood) => !AWAKE_MARK_MOODS.includes(mood)).sort())
      .toEqual(['done', 'failed', 'stopped']);
  });
});
