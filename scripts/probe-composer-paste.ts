import { app, BrowserWindow } from 'electron';
import { performance } from 'node:perf_hooks';
import {
  classifyComposerPaste,
  MAX_COMPOSER_INLINE_ATOMS,
  MAX_COMPOSER_UTF16_UNITS,
  MAX_INLINE_PASTE_BREAKS,
  MAX_INLINE_PASTE_UTF8_BYTES,
} from '../src/renderer/agent/composerPasteAdmission';

interface Corpus {
  readonly kind: 'long-line' | 'newline-dense' | 'mixed';
  readonly label: string;
  readonly units: number;
}

const CORPORA: readonly Corpus[] = [
  { kind: 'long-line', label: 'long-line-inline-boundary', units: MAX_INLINE_PASTE_UTF8_BYTES },
  { kind: 'long-line', label: 'long-line-aggregate-boundary', units: MAX_COMPOSER_UTF16_UNITS },
  { kind: 'newline-dense', label: 'newline-inline-boundary', units: MAX_INLINE_PASTE_BREAKS },
  { kind: 'newline-dense', label: 'newline-aggregate-boundary', units: MAX_COMPOSER_INLINE_ATOMS },
  { kind: 'mixed', label: 'mixed-inline-boundary', units: MAX_INLINE_PASTE_UTF8_BYTES },
];

async function main(): Promise<number> {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL('data:text/html,<main id="root"></main>');
  try {
    const results = [];
    for (const corpus of CORPORA) {
      const text = corpusText(corpus);
      const classifyStartedAt = performance.now();
      let admission = classifyComposerPaste({
        current: { inlineAtoms: 0, utf16Units: 0 },
        incomingText: text,
        selected: { inlineAtoms: 0, utf16Units: 0 },
      });
      for (let warmup = 0; warmup < 9; warmup += 1) {
        admission = classifyComposerPaste({
          current: { inlineAtoms: 0, utf16Units: 0 },
          incomingText: text,
          selected: { inlineAtoms: 0, utf16Units: 0 },
        });
      }
      const classificationMs = (performance.now() - classifyStartedAt) / 10;
      const renderer = await rendererProbe(window, corpus);
      results.push({
        ...corpus,
        admission: admission.outcome,
        classificationMs,
        ...renderer,
      });
    }
    console.log(JSON.stringify({
      runtime: { electron: process.versions.electron, node: process.versions.node },
      limits: {
        aggregateAtoms: MAX_COMPOSER_INLINE_ATOMS,
        aggregateUtf16Units: MAX_COMPOSER_UTF16_UNITS,
        pasteBreaks: MAX_INLINE_PASTE_BREAKS,
        pasteUtf8Bytes: MAX_INLINE_PASTE_UTF8_BYTES,
      },
      results,
    }, null, 2));
    return 0;
  } finally {
    window.destroy();
  }
}

function corpusText(corpus: Corpus): string {
  if (corpus.kind === 'long-line') return 'x'.repeat(corpus.units);
  if (corpus.kind === 'newline-dense') return '\n'.repeat(corpus.units);
  const line = 'const value = pastedContent;\n';
  return line.repeat(Math.ceil(corpus.units / line.length)).slice(0, corpus.units);
}

async function rendererProbe(window: BrowserWindow, corpus: Corpus): Promise<Record<string, number>> {
  return window.webContents.executeJavaScript(`(${rendererProbeSource})(${JSON.stringify(corpus)})`, true);
}

const rendererProbeSource = String.raw`async function probe(corpus) {
  const root = document.querySelector('#root');
  root.replaceChildren();
  const editor = document.createElement('p');
  editor.contentEditable = 'true';
  root.append(editor);
  const text = corpus.kind === 'long-line'
    ? 'x'.repeat(corpus.units)
    : corpus.kind === 'newline-dense'
      ? '\n'.repeat(corpus.units)
      : 'const value = pastedContent;\n'.repeat(Math.ceil(corpus.units / 29)).slice(0, corpus.units);
  const fragment = document.createDocumentFragment();
  const startedAt = performance.now();
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]) fragment.append(document.createTextNode(lines[index]));
    if (index < lines.length - 1) fragment.append(document.createElement('br'));
  }
  editor.append(fragment);
  const constructionMs = performance.now() - startedAt;
  const frameStartedAt = performance.now();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const pasteToFrameMs = performance.now() - frameStartedAt;
  const editStartedAt = performance.now();
  editor.append(document.createTextNode('x'));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const nextEditToFrameMs = performance.now() - editStartedAt;
  return {
    constructionMs,
    domNodes: editor.childNodes.length,
    nextEditToFrameMs,
    pasteToFrameMs,
  };
}`;

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  })
  .then((exitCode) => {
    process.exitCode = exitCode;
    app.exit(exitCode);
  });
