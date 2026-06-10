/**
 * QA probe for issue #176: IME composition torn apart by the split echo's
 * focus steal (pinyin "skill" → "sk ill").
 *
 * Drives a REAL running app over CDP — synthetic CGEvent/AppleScript keystrokes
 * bypass the macOS IME entirely, and the e2e mock has no real async core echo,
 * so this is the only repeatable way to exercise the race. Technique (verified
 * in the issue's diagnosis): per letter, a `rawKeyDown` with vk=229 followed by
 * `Input.imeSetComposition`, then `Input.insertText` commits like picking a
 * candidate.
 *
 * Run the app with remote debugging, then the probe:
 *
 *     ELECTRON_USER_DATA_DIR="$HOME/.lin-outliner-cc-2" \
 *       bunx electron-vite dev -- --remote-debugging-port=9333
 *     bun scripts/probe-ime-split.ts [--port 9333]
 *
 * Sequence: click into the first outliner row (caret at end) → Enter → start
 * composing "skill" ~20 ms later, one letter every ~90 ms, so the split/create
 * echo (~60-80 ms) lands mid-composition → commit.
 *
 * PASS (the #176 invariants):
 *   1. Exactly one compositionend, carrying the FULL composed text — the echo
 *      never force-committed the composition (no focusout mid-composition).
 *   2. The composed word lands whole in the NEW row; the old row is unchanged.
 */

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 9333;
const COMPOSED = 'skill';

interface CdpTarget {
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') return; // ignore CDP events
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error(`WebSocket connect failed: ${url}`)));
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
    );
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.text}\n${expression}`);
    return result.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The main window is the page that renders an outliner (the launcher doesn't). */
async function connectToOutlinerPage(): Promise<Cdp> {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as CdpTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
  for (const page of pages) {
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl!);
    try {
      const hasRows = await cdp.evaluate<boolean>("Boolean(document.querySelector('.outliner .row-editor'))");
      if (hasRows) {
        console.log(`target: ${page.title} — ${page.url}`);
        return cdp;
      }
    } catch {
      // fall through to the next candidate
    }
    cdp.close();
  }
  throw new Error(`no page with outliner rows among ${pages.length} candidate(s) on port ${PORT}`);
}

interface ProbeEvent {
  t: number;
  type: string;
  data?: string;
}

const INSTRUMENT = `(() => {
  window.__imeProbe = [];
  const log = (type, data) => window.__imeProbe.push({ t: Math.round(performance.now()), type, data });
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    window.addEventListener(type, (e) => log(type, e.data ?? ''), true);
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter') log('keydown', 'Enter'); }, true);
  for (const type of ['focusin', 'focusout']) {
    window.addEventListener(type, (e) => {
      const editor = e.target instanceof Element ? e.target.closest('.row-editor') : null;
      if (editor) log(type, editor.textContent ?? '');
    }, true);
  }
  return true;
})()`;

const ROW_TEXTS = `Array.from(document.querySelectorAll('.outliner .row-editor'), (el) => el.textContent ?? '')`;
// An empty draft row's editor is ~1px wide, so a right-edge click lands on the
// bullet. Click the contenteditable's center (real focus), then collapse the
// DOM selection to the end — ProseMirror adopts it on selectionchange.
const FIRST_ROW_CLICK_POINT = `(() => {
  const el = document.querySelector('.outliner .row-editor .ProseMirror')
    ?? document.querySelector('.outliner .row-editor');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.max(4, r.width / 2)), y: Math.round(r.top + r.height / 2) };
})()`;
const COLLAPSE_TO_END = `(() => {
  const el = document.querySelector('.outliner .row-editor .ProseMirror');
  if (!el) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
})()`;

async function clickFirstRowEnd(cdp: Cdp): Promise<void> {
  const point = await cdp.evaluate<{ x: number; y: number } | null>(FIRST_ROW_CLICK_POINT);
  if (!point) throw new Error('no outliner row editor found');
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await sleep(120);
  await cdp.evaluate(COLLAPSE_TO_END);
  await sleep(60);
}

async function main(): Promise<void> {
  const cdp = await connectToOutlinerPage();

  // A fresh page per run: prior runs leave instrument listeners (and editor
  // state) behind; reload makes the probe repeatable.
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  for (let i = 0; i < 100; i += 1) {
    await sleep(100);
    const ready = await cdp.evaluate<boolean>(
      "document.readyState === 'complete' && Boolean(document.querySelector('.outliner .row-editor'))",
    ).catch(() => false);
    if (ready) break;
    if (i === 99) throw new Error('page did not become ready after reload');
  }
  await sleep(300);
  await cdp.evaluate(INSTRUMENT);

  // An empty first row (a fresh doc's trailing draft) can't host a split —
  // seed it with text so Enter exercises the real row path.
  await clickFirstRowEnd(cdp);
  const seedTexts = await cdp.evaluate<string[]>(ROW_TEXTS);
  if ((seedTexts[0] ?? '') === '') {
    await cdp.send('Input.insertText', { text: 'imeprobe seed' });
    await sleep(500);
  }

  const before = await cdp.evaluate<string[]>(ROW_TEXTS);
  const oldRowText = before[0];

  // Click again: a real caret at the end of the (now materialized) first row.
  await clickFirstRowEnd(cdp);

  // Enter as a synthetic DOM keydown on the focused editor. CDP
  // Input.dispatchKeyEvent only reaches an OS-FOCUSED window (unlike the
  // mouse/IME injection used elsewhere), which would make the probe flaky on a
  // busy desktop. The race under test — the real core echo vs the real Blink
  // composition — is untouched; Enter is only the trigger, and ProseMirror's
  // keydown handling doesn't distinguish synthetic events. Returning the
  // dispatch from evaluate() also sequences it deterministically BEFORE the
  // first imeSetComposition below.
  const enterHandled = await cdp.evaluate<boolean>(`(() => {
    const el = document.activeElement;
    if (!el || !el.classList.contains('ProseMirror')) return false;
    return !el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  })()`);
  if (!enterHandled) throw new Error('Enter keydown was not handled by the focused editor');

  for (let i = 1; i <= COMPOSED.length; i += 1) {
    const prefix = COMPOSED.slice(0, i);
    const letter = COMPOSED[i - 1];
    const code = `Key${letter.toUpperCase()}`;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Process', code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
    });
    await cdp.send('Input.imeSetComposition', {
      text: prefix, selectionStart: prefix.length, selectionEnd: prefix.length,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Process', code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
    });
    await sleep(90);
  }
  await cdp.send('Input.insertText', { text: COMPOSED });
  await sleep(600);

  const events = await cdp.evaluate<ProbeEvent[]>('window.__imeProbe');
  const after = await cdp.evaluate<string[]>(ROW_TEXTS);
  cdp.close();

  console.log('\nevent log:');
  for (const e of events) console.log(`  ${e.t} ${e.type}${e.data !== undefined ? ` data=${JSON.stringify(e.data)}` : ''}`);
  console.log(`\nrows before: ${JSON.stringify(before)}`);
  console.log(`rows after:  ${JSON.stringify(after)}`);

  const failures: string[] = [];
  const ends = events.filter((e) => e.type === 'compositionend');
  if (ends.length !== 1) {
    failures.push(`expected exactly 1 compositionend, got ${ends.length} — the composition was force-committed`);
  } else if (ends[0].data !== COMPOSED) {
    failures.push(`compositionend carried ${JSON.stringify(ends[0].data)}, expected the full ${JSON.stringify(COMPOSED)}`);
  }
  const startIdx = events.findIndex((e) => e.type === 'compositionstart');
  const endIdx = events.findIndex((e) => e.type === 'compositionend');
  if (events.slice(Math.max(0, startIdx), Math.max(0, endIdx)).some((e) => e.type === 'focusout')) {
    failures.push('focusout fired mid-composition — the echo stole focus');
  }
  if (after.length !== before.length + 1) {
    failures.push(`expected ${before.length + 1} rows, got ${after.length}`);
  } else {
    if (after[0] !== oldRowText) failures.push(`old row changed: ${JSON.stringify(oldRowText)} → ${JSON.stringify(after[0])}`);
    if (after[1] !== COMPOSED) failures.push(`new row is ${JSON.stringify(after[1])}, expected ${JSON.stringify(COMPOSED)}`);
  }

  if (failures.length > 0) {
    console.log('\nFAIL');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\nPASS — composition survived the echo; composed text landed whole in the new row');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
