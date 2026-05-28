// Dev-only render probe. Counts OutlinerItem renders and times the synchronous
// re-render that each command triggers, so we can measure per-keystroke renderer
// cost on a large document before deciding whether memoization is worthwhile.
//
// Off by default (zero console noise, ~one boolean check per render). Enable from
// the DevTools console and reload:
//   localStorage.setItem('lin:render-probe', '1')
// Disable again with:
//   localStorage.removeItem('lin:render-probe')
//
// Each command then logs one line, e.g. `[render] 12.3ms items=487` — the wall
// time of the synchronous React commit and how many OutlinerItem render
// functions ran during it.

function readFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('lin:render-probe') === '1';
  } catch {
    return false;
  }
}

export const RENDER_PROBE_ENABLED = readFlag();

let outlinerItemRenders = 0;
let lastIndexMs = 0;

export function noteOutlinerItemRender(): void {
  if (RENDER_PROBE_ENABLED) outlinerItemRenders += 1;
}

// Wrap the per-command index recomputation (signatures + revision diff). The
// duration is reported by the next measureRender as `index=`, so we can tell how
// much of a command's cost is index bookkeeping vs React render/reconcile.
export function measureRenderIndex<T>(run: () => T): T {
  if (!RENDER_PROBE_ENABLED) return run();
  const start = performance.now();
  const result = run();
  // Keep the max since the last measureRender reset: React StrictMode invokes
  // the memo factory twice in dev and the second (idempotent) pass takes a cheap
  // cache-hit path, which would otherwise mask the real first-pass cost.
  lastIndexMs = Math.max(lastIndexMs, performance.now() - start);
  return result;
}

// Wrap a synchronous re-render (the command `flushSync`). Logs total wall time,
// the index time observed during it, and how many OutlinerItem renders ran.
export function measureRender<T>(run: () => T): T {
  if (!RENDER_PROBE_ENABLED) return run();
  const before = outlinerItemRenders;
  lastIndexMs = 0;
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  console.log(`[render] ${ms.toFixed(1)}ms index=${lastIndexMs.toFixed(1)}ms items=${outlinerItemRenders - before}`);
  return result;
}
