// Frontmost-app + active-browser-tab detection for context capture.
//
// Layered so each step degrades independently (A-grade capture needs neither step
// to succeed):
//   1. getFrontmostApp()  — which app is in front (no TCC; NSWorkspace).
//   2. getActiveTab()     — the front tab's URL+title (Automation TCC).
//
// Capture is basic-info only (URL + title); rich in-page extraction was removed in
// favor of the planned browser extension / CDP backend (see contextCapture.ts and
// docs/plans/browser-extension-integration.md). Each function returns a typed
// result or null; the orchestrator folds whatever succeeded into an ExternalContext.
// No step ever throws (runOsascript never throws).

import { runOsascript } from '../osascript';
import { activeTabScript, TAB_FIELD_SEPARATOR } from './browserScripts';
import type { BrowserFamily } from './browserScripts';

export interface FrontmostApp {
  name: string;
  bundleId?: string;
  /** OS process id of the frontmost app — needed to target it via the AX API. */
  pid?: number;
}

export interface ActiveTab {
  url: string;
  title: string;
}

/**
 * Chromium-family browsers whose AppleScript dictionary exposes
 * `execute active tab of front window javascript` and `active tab of front
 * window`. Arc/Orion use a different model and are intentionally excluded — they
 * fall through to the frontmost-app-only path until a dedicated provider lands.
 */
const CHROMIUM_APPS = new Set<string>([
  'Google Chrome',
  'Google Chrome Canary',
  'Google Chrome Dev',
  'Google Chrome Beta',
  'Chromium',
  'Brave Browser',
  'Brave Browser Beta',
  'Brave Browser Nightly',
  'Microsoft Edge',
  'Microsoft Edge Dev',
  'Microsoft Edge Canary',
  'Microsoft Edge Beta',
  'Vivaldi',
  'Opera',
]);

const SAFARI_APPS = new Set<string>(['Safari', 'Safari Technology Preview']);

/** Map a frontmost app name to a scriptable browser family, or null. */
export function detectBrowserFamily(appName: string): BrowserFamily | null {
  if (CHROMIUM_APPS.has(appName)) return 'chromium';
  if (SAFARI_APPS.has(appName)) return 'safari';
  return null;
}

// JXA: frontmost app via NSWorkspace — needs no TCC grant (it does not read
// other apps' windows, only the workspace's own frontmost pointer). Passed to
// osascript as a direct argv, so no AppleScript-string escaping applies here.
const FRONTMOST_JXA =
  "ObjC.import('AppKit');" +
  '(function(){' +
  'var ws=$.NSWorkspace.sharedWorkspace;' +
  'var app=ws.frontmostApplication;' +
  "if(!app)return '{}';" +
  "var name=app.localizedName?app.localizedName.js:'';" +
  "var bid=app.bundleIdentifier?app.bundleIdentifier.js:'';" +
  'var pid=app.processIdentifier;' +
  'return JSON.stringify({name:name,bundleId:bid,pid:pid});' +
  '})()';

export async function getFrontmostApp(timeoutMs = 800): Promise<FrontmostApp | null> {
  const result = await runOsascript({ language: 'JavaScript', script: FRONTMOST_JXA, timeoutMs });
  if (!result.ok || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      name?: string;
      bundleId?: string;
      pid?: number;
    };
    if (!parsed.name) return null;
    return {
      name: parsed.name,
      ...(parsed.bundleId ? { bundleId: parsed.bundleId } : {}),
      ...(typeof parsed.pid === 'number' && parsed.pid > 0 ? { pid: parsed.pid } : {}),
    };
  } catch {
    return null;
  }
}

export async function getActiveTab(
  family: BrowserFamily,
  appName: string,
  timeoutMs = 800,
): Promise<ActiveTab | null> {
  const result = await runOsascript({
    language: 'AppleScript',
    script: activeTabScript(family, appName),
    timeoutMs,
  });
  if (!result.ok || !result.stdout) return null;
  const sepIndex = result.stdout.indexOf(TAB_FIELD_SEPARATOR);
  if (sepIndex < 0) {
    // Only the URL came back (no title), or an unexpected shape.
    return { url: result.stdout, title: '' };
  }
  const url = result.stdout.slice(0, sepIndex).trim();
  const title = result.stdout.slice(sepIndex + TAB_FIELD_SEPARATOR.length).trim();
  if (!url) return null;
  return { url, title };
}
