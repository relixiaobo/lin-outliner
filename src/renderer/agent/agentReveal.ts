import { linAgentRuntimeStore } from './runtime';
import { api } from '../api/client';
import type { ReferenceTarget } from '../api/types';

// A tiny decoupled channel for "surface the agent panel on this conversation".
// Content rows (e.g. a command node's Run button) are deep in the outliner tree
// and have no path to the App-local agent rail state, so instead of prop-drilling
// a callback they call `requestRevealAgentConversation`. App subscribes once and
// opens the rail; conversation selection goes straight through the singleton
// runtime store. Kept off the runtime store's snapshot so App never re-renders on
// agent streaming — only on an actual reveal request.

export interface AgentRevealOptions {
  /** Also open the Work panel (where command runs surface as Runs). A command Run
   *  spawns a parentless child run, which lands in Work rather than the main
   *  transcript, so the Run flow asks for it. */
  openWork?: boolean;
  /** Scroll/highlight a chat-source citation inside the revealed transcript. */
  transcriptTarget?: AgentChatSourceRevealTarget;
}

export type AgentChatSourceRevealTarget = Extract<ReferenceTarget, { kind: 'chat-source' }>;

type RevealListener = (conversationId: string, options: AgentRevealOptions) => void;

const listeners = new Set<RevealListener>();

/** Select `conversationId` in the agent runtime and ask any listener (App opens
 *  the rail; the chat panel may open Work) to surface it. Returns the
 *  selection promise so callers can await the conversation being loaded before doing
 *  anything that mutates it (e.g. starting a run) — selecting concurrently with a
 *  run recreates the conversation and diverges the event seq. The conversation must
 *  already exist (selecting a not-yet-created one rejects). */
export function requestRevealAgentConversation(
  conversationId: string,
  options: AgentRevealOptions = {},
): Promise<void> {
  for (const listener of listeners) listener(conversationId, options);
  return linAgentRuntimeStore.selectConversation(conversationId);
}

export async function requestRevealChatSource(target: AgentChatSourceRevealTarget): Promise<void> {
  if (target.stream === 'conversation') {
    await requestRevealAgentConversation(target.streamId, { transcriptTarget: target });
    return;
  }

  // Run ids are global; resolve the owning conversation in one read rather than
  // probing every conversation's ledger. A null result means the run is unknown
  // (evicted/never-seeded) — there is nothing to reveal, so leave the UI as-is.
  const conversationId = await api.agentRunConversationId(target.streamId);
  if (!conversationId) return;
  await requestRevealAgentConversation(conversationId, { transcriptTarget: target });
}

/** Subscribe to reveal requests. Returns an unsubscribe. */
export function onAgentRevealRequest(listener: RevealListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
