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

// Surface the node count a result carries across IPC: a `CommandResult` wraps a
// `ProjectionUpdate` under `.update` (delta → changed-node count; full →
// projection size); a `ProjectionSnapshot` (init/get_projection) holds
// `.projection`; a bare projection exposes `nodes[]` directly.
function projectionNodeCount(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const update = (result as { update?: unknown }).update;
  if (update && typeof update === 'object') {
    const kind = (update as { kind?: unknown }).kind;
    if (kind === 'delta') {
      const changed = (update as { changedNodes?: unknown }).changedNodes;
      return Array.isArray(changed) ? changed.length : undefined;
    }
    const projection = (update as { projection?: { nodes?: unknown } }).projection;
    return Array.isArray(projection?.nodes) ? projection.nodes.length : undefined;
  }
  const candidate = (result as { projection?: unknown }).projection ?? result;
  const nodes = (candidate as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.length : undefined;
}
