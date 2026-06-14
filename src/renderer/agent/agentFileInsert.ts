// A tiny decoupled channel for "save this agent working file into the outliner".
// A file chip is deep in the agent message tree and has no path to the App-local
// document state the ingest bridge needs (the command runner, the document index,
// and the user-view context that resolves the target node). Rather than prop-drill
// a callback through the ~8 render functions between App and the chip, the chip
// calls `requestInsertFileIntoOutliner(path)`; App registers the bridge once and
// runs ingest (path -> committed asset) + create-node. Mirrors `agentReveal.ts`.
//
// Single-handler (not a listener Set): the request must return the bridge's promise
// so the chip can await completion and confirm only on a real insert, and there is
// exactly one App registering it.

type InsertFileHandler = (path: string) => Promise<boolean>;

let handler: InsertFileHandler | null = null;

/** Ingest the working file at `path` into the outliner. Resolves to `true` when a
 *  node was created, `false` when nothing was inserted (no bridge yet, or the file
 *  is gone / outside the agent's trusted roots — e.g. a stale chip in an old
 *  conversation whose working file was GC'd). Rejects if the bridge throws. The chip
 *  confirms only on `true`, so a no-op never shows a false "inserted". */
export function requestInsertFileIntoOutliner(path: string): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  return handler(path);
}

/** Register the ingest bridge (App). Returns an unsubscribe; the last registration
 *  wins, matching "App subscribes once". */
export function onInsertFileIntoOutlinerRequest(next: InsertFileHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}
