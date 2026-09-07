import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { SkillReview } from '../../core/agent/skillOperations';
import type { ReviewSkillOperation } from '../hostDomain/skillLifecycle';
import { AgentToolFailure } from '../agent/AgentToolFailure';

export function createSkillReviewHost(createWindow: (input: Parameters<ReviewSkillOperation>[0]) => BrowserWindow) {
  const pending = new Map<number, { window: BrowserWindow; review: SkillReview; decide: (approved: boolean) => void }>();
  const review: ReviewSkillOperation = async (input) => {
    input.caller.signal?.throwIfAborted();
    const remaining = input.expiresAt - Date.now();
    if (remaining <= 0) throw new AgentToolFailure('review_expired', 'The Skill review expired.', 'Inspect the source again.');
    let window: BrowserWindow;
    try { window = createWindow(input); }
    catch { throw new AgentToolFailure('interaction_unavailable', 'A Skill review window is unavailable.', 'Continue only when the app can show the review.'); }
    const contents = window.webContents;
    const senderId = contents.id;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (approved: boolean, expired = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.caller.signal?.removeEventListener('abort', cancel);
        pending.delete(senderId);
        if (expired || Date.now() >= input.expiresAt) {
          reject(new AgentToolFailure('review_expired', 'The Skill review expired.', 'Inspect the source again.'));
        } else {
          resolve(approved && !input.caller.signal?.aborted);
        }
        if (!window.isDestroyed()) window.close();
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(false, true), remaining);
      pending.set(senderId, { window, review: input.review, decide: finish });
      window.once('closed', cancel);
      contents.once('render-process-gone', cancel);
      contents.once('did-fail-load', cancel);
      input.caller.signal?.addEventListener('abort', cancel, { once: true });
      if (input.caller.signal?.aborted) cancel();
    });
  };
  function owned(event: IpcMainInvokeEvent) {
    const entry = pending.get(event.sender.id);
    if (!entry || entry.window.isDestroyed() || event.sender !== entry.window.webContents
      || event.senderFrame !== event.sender.mainFrame) throw new Error('This sender does not own an active Skill review.');
    return entry;
  }
  return {
    review,
    read: (event: IpcMainInvokeEvent) => owned(event).review,
    decide: (event: IpcMainInvokeEvent, approved: unknown) => {
      if (typeof approved !== 'boolean') throw new Error('A Skill review accepts only a decision.');
      owned(event).decide(approved);
    },
    release: () => { for (const entry of [...pending.values()]) entry.decide(false); },
  };
}
