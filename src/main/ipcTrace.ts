// Opt-in IPC instrumentation (set LIN_TRACE_IPC=1). Logs per-command duration,
// the serialized payload size, and — when a command returns a projection — its
// node count. The point is to quantify the full-projection-per-command cost with
// real data before deciding whether delta projection is worth its protocol
// change. Zero overhead when the flag is off.

export const IPC_TRACE_ENABLED = process.env.LIN_TRACE_IPC === '1';

export function traceIpc(command: string, result: unknown, durationMs: number): void {
  let bytes = 0;
  try {
    const json = JSON.stringify(result);
    if (json) bytes = Buffer.byteLength(json);
  } catch {
    // Non-serializable result (rare) — skip the size estimate.
  }
  const nodeCount = projectionNodeCount(result);
  const sizePart = `${(bytes / 1024).toFixed(1)}kB`;
  const nodePart = nodeCount != null ? ` nodes=${nodeCount}` : '';
  console.log(`[ipc] ${command} ${durationMs.toFixed(1)}ms ${sizePart}${nodePart}`);
}

// A command outcome carries the projection under `.projection`; a bare
// get_projection returns the projection itself. Both expose `nodes[]`.
function projectionNodeCount(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const candidate = (result as { projection?: unknown }).projection ?? result;
  const nodes = (candidate as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.length : undefined;
}
