import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { createSkillReviewHost } from '../../src/main/hostPlatform/skillReviewHost';
import type { SkillReview } from '../../src/core/agent/skillOperations';
import type { SkillOperationCaller } from '../../src/main/hostDomain/skillLifecycle';

class ReviewWindow extends EventEmitter {
  destroyed = false;
  readonly contents = Object.assign(new EventEmitter(), { id: Math.random(), mainFrame: {} });
  get webContents() { if (this.destroyed) throw new Error('Object has been destroyed'); return this.contents; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); }
  event(frame = this.contents.mainFrame) { return { sender: this.contents, senderFrame: frame } as unknown as IpcMainInvokeEvent; }
}
const review: SkillReview = { kind: 'install', discovery: { id: 'discovery' }, candidate: { name: 'reviewed' } } as SkillReview;
const caller = { key: 'caller', origin: { kind: 'agent', threadId: 'thread', turnId: 'turn', itemId: 'item' } } as SkillOperationCaller;

describe('Skill review window ownership', () => {
  test('rejects foreign frames, forged senders and replay while keeping reviews independent', async () => {
    const windows: ReviewWindow[] = [];
    const host = createSkillReviewHost(() => {
      const window = new ReviewWindow(); windows.push(window); return window as unknown as BrowserWindow;
    });
    const first = host.review({ review, caller, expiresAt: Date.now() + 60_000 });
    const second = host.review({ review, caller: { ...caller, key: 'other' }, expiresAt: Date.now() + 60_000 });
    expect(host.read(windows[0]!.event())).toEqual(review);
    expect(() => host.decide(windows[0]!.event({}), true)).toThrow('sender');
    expect(() => host.decide(new ReviewWindow().event(), true)).toThrow('sender');
    expect(() => host.decide(windows[0]!.event(), { approved: true })).toThrow('only a decision');
    const firstEvent = windows[0]!.event();
    host.decide(firstEvent, true);
    expect(await first).toBe(true);
    expect(() => host.decide(firstEvent, true)).toThrow('sender');
    expect(windows[1]!.destroyed).toBe(false);
    host.decide(windows[1]!.event(), false);
    expect(await second).toBe(false);
  });

  test('caller abort, review-window loss, timeout and Host release settle without a decision', async () => {
    for (const action of ['abort', 'close', 'release', 'timeout', 'render-process-gone', 'did-fail-load'] as const) {
      const window = new ReviewWindow();
      const host = createSkillReviewHost(() => window as unknown as BrowserWindow);
      const controller = new AbortController();
      const pending = host.review({ review, caller: { ...caller, signal: controller.signal },
        expiresAt: Date.now() + (action === 'timeout' ? 5 : 60_000) });
      if (action === 'abort') controller.abort();
      if (action === 'close') window.close();
      if (action === 'release') host.release();
      if (action === 'render-process-gone' || action === 'did-fail-load') window.contents.emit(action);
      if (action === 'timeout') await expect(pending).rejects.toMatchObject({ code: 'review_expired' });
      else expect(await pending).toBe(false);
      expect(window.destroyed).toBe(true);
    }
  });

  test('fails without a surface and refuses already expired reviews', async () => {
    const host = createSkillReviewHost(() => { throw new Error('Host unavailable'); });
    await expect(host.review({ review, caller, expiresAt: Date.now() + 100 })).rejects.toMatchObject({ code: 'interaction_unavailable' });
    await expect(host.review({ review, caller, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'review_expired' });
  });
});
