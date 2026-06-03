/**
 * Phase 0 feasibility probe for the lazy-like global launcher.
 *
 * Validates the long pole BEFORE any build phase: can we, from a Node/Electron
 * process, use `osascript` to (a) read the frontmost app, (b) read a Chromium /
 * Safari active tab URL+title, and (c) run an allowlisted READ-ONLY JS snippet in
 * the active tab and get JSON back — and how fast is the round trip?
 *
 * Run it directly (no Electron needed) to validate the *mechanism* + latency:
 *
 *     bun scripts/probe-launcher-context.ts
 *
 * First run pops macOS Automation (TCC) consent dialogs for System Events /
 * Google Chrome / Safari — approving them IS the test. If in-page JS fails with
 * "Executing JavaScript through AppleScript is turned off", enable the per-browser
 * toggle (Chrome: View → Developer → Allow JavaScript from Apple Events; Safari:
 * Develop → Allow JavaScript from Apple Events) and re-run. That toggle is a
 * SEPARATE gate from the Automation grant.
 *
 * What this probe does NOT cover (must be checked from the packaged app, see
 * docs/plans/lazy-like-global-launcher.md "Phase 0"): whether the Automation
 * grant *persists across relaunch* for the project's UNSIGNED build
 * (`mac.identity: null`). The calling process here is your terminal/bun, which
 * has a stable identity; an unsigned Electron app may behave differently.
 *
 * This file is also the working prototype of the real `runOsascript` wrapper the
 * plan calls for: timeout-bound, child killed on timeout, JSON-out, read-only.
 */

import { spawn } from 'node:child_process';

interface OsascriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

/** Read-only, timeout-bound osascript runner. Kills the child on timeout. */
function runOsascript(script: string, timeoutMs: number): Promise<OsascriptResult> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    // `osascript -` reads the script from stdin, so we never shell-interpolate.
    const child = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ms: Math.round(performance.now() - startedAt),
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: '',
        stderr: String(err),
        ms: Math.round(performance.now() - startedAt),
        timedOut,
      });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

/** Escape a JS source string for embedding inside an AppleScript string literal. */
function asString(js: string): string {
  return js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The allowlisted, READ-ONLY in-page snippet. No DOM writes, clicks, scroll,
 * navigation, or network. Returns a JSON string (Chrome/Safari hand back the
 * value of the last expression).
 */
const READ_ONLY_PAGE_JS = `(() => {
  const attr = (sel, name) => { const el = document.querySelector(sel); return el ? el.getAttribute(name) : null; };
  return JSON.stringify({
    url: location.href,
    title: document.title,
    ogTitle: attr('meta[property="og:title"]', 'content'),
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
  });
})()`;

// Per-step budgets mirror the plan's "Suggested timeout budget".
const BUDGET = { frontmost: 120, tab: 250, siteJs: 400 } as const;

function classifyJsError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('javascript') && (s.includes('turned off') || s.includes('not allowed') || s.includes('disabled'))) {
    return 'TOGGLE-OFF: enable "Allow JavaScript from Apple Events" for this browser, then re-run.';
  }
  if (s.includes('not authorized') || s.includes('1743') || s.includes('-1743')) {
    return 'TCC-DENIED: Automation permission denied. Approve the dialog, or grant it in System Settings → Privacy & Security → Automation.';
  }
  if (s.includes("can't get") || s.includes('-1728') || s.includes('no window')) {
    return 'NO-ACTIVE-TAB: open a normal tab in the target browser and bring it to the front.';
  }
  return stderr || 'unknown error';
}

function pretty(r: OsascriptResult, budgetMs?: number): string {
  const within = budgetMs == null ? '' : r.ms <= budgetMs ? `  (≤${budgetMs}ms budget ✓)` : `  (OVER ${budgetMs}ms budget ✗)`;
  return `${r.ms}ms${within}`;
}

async function main() {
  console.log('=== Phase 0 launcher-context probe ===');
  console.log('First run will prompt for Automation permission (System Events / Chrome / Safari).');
  console.log('Bring a real browser tab to the front for the in-page JS steps.\n');

  let go = true;

  // Step A — frontmost app.
  const frontmost = await runOsascript(
    'tell application "System Events" to get name of first application process whose frontmost is true',
    BUDGET.frontmost * 6, // generous timeout; we report against budget separately
  );
  if (frontmost.ok) {
    console.log(`[A] frontmost app: "${frontmost.stdout}"  ${pretty(frontmost, BUDGET.frontmost)}`);
  } else {
    go = false;
    console.log(`[A] frontmost app: FAILED  ${pretty(frontmost)} — ${classifyJsError(frontmost.stderr)}`);
  }

  // Step B — Chrome active tab URL + title.
  const chromeTab = await runOsascript(
    [
      'tell application "Google Chrome"',
      '  if (count of windows) is 0 then error "no window"',
      '  set t to active tab of front window',
      '  return (URL of t) & "\\t" & (title of t)',
      'end tell',
    ].join('\n'),
    BUDGET.tab * 6,
  );
  if (chromeTab.ok) {
    const [url, title] = chromeTab.stdout.split('\t');
    console.log(`[B] Chrome tab: ${title ?? ''}\n         ${url ?? ''}  ${pretty(chromeTab, BUDGET.tab)}`);
  } else {
    console.log(`[B] Chrome tab: SKIPPED/FAILED  ${pretty(chromeTab)} — ${classifyJsError(chromeTab.stderr)}`);
  }

  // Step C — Chrome in-page READ-ONLY JS (the critical capability).
  const chromeJs = await runOsascript(
    [
      'tell application "Google Chrome"',
      '  if (count of windows) is 0 then error "no window"',
      '  set t to active tab of front window',
      `  return execute t javascript "${asString(READ_ONLY_PAGE_JS)}"`,
      'end tell',
    ].join('\n'),
    BUDGET.siteJs * 6,
  );
  if (chromeJs.ok && chromeJs.stdout) {
    let parsed: unknown = chromeJs.stdout;
    try { parsed = JSON.parse(chromeJs.stdout); } catch { /* keep raw */ }
    console.log(`[C] Chrome in-page JS: OK  ${pretty(chromeJs, BUDGET.siteJs)}`);
    console.log(`         ${JSON.stringify(parsed)}`);
  } else {
    go = false;
    console.log(`[C] Chrome in-page JS: FAILED  ${pretty(chromeJs)} — ${classifyJsError(chromeJs.stderr || chromeJs.stdout)}`);
  }

  // Step D — Safari in-page READ-ONLY JS (optional; same toggle story).
  const safariJs = await runOsascript(
    [
      'tell application "Safari"',
      '  if (count of documents) is 0 then error "no window"',
      `  return (do JavaScript "${asString(READ_ONLY_PAGE_JS)}" in document 1)`,
      'end tell',
    ].join('\n'),
    BUDGET.siteJs * 6,
  );
  if (safariJs.ok && safariJs.stdout) {
    let parsed: unknown = safariJs.stdout;
    try { parsed = JSON.parse(safariJs.stdout); } catch { /* keep raw */ }
    console.log(`[D] Safari in-page JS: OK  ${pretty(safariJs, BUDGET.siteJs)}`);
    console.log(`         ${JSON.stringify(parsed)}`);
  } else {
    console.log(`[D] Safari in-page JS: SKIPPED/FAILED  ${pretty(safariJs)} — ${classifyJsError(safariJs.stderr || safariJs.stdout)}`);
  }

  console.log('\n=== Verdict (mechanism layer) ===');
  console.log(go
    ? 'GO (mechanism): frontmost + active-tab + in-page JS all worked from this process.'
    : 'NO-GO (mechanism): an essential step failed — see the hints above before building Phase 1.');
  console.log('STILL TO VERIFY from the packaged UNSIGNED app (not covered here):');
  console.log('  • Automation grant persists across an app relaunch / rebuild (unsigned-identity risk).');
  console.log('  • Latency from inside Electron main (osascript spawn cost may differ).');
  console.log('  • Per-browser fallback UX when the "Allow JavaScript from Apple Events" toggle is off.');
}

void main();
