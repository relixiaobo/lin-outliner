import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  clickInstalledFocusTarget,
  composerRefocusDecision,
  type ComposerRefocusClick,
} from '../../src/renderer/agent/composerRefocus';

const { document } = parseHTML(`<html><body>
  <div class="thread-view">
    <div class="thread-transcript">
      <p id="prose">Agent answer text</p>
      <button id="copy" type="button"><span id="copy-glyph">copy</span></button>
      <a id="node-ref" href="#lin-node:abc"><span id="node-ref-label">node</span></a>
      <details><summary id="disclosure">Thought</summary></details>
      <div id="popover" tabindex="0"><ol><li id="popover-step">step one</li></ol></div>
      <div id="editor" contenteditable="true"><p id="editor-text">draft</p></div>
      <input id="field" />
    </div>
    <div id="blank"></div>
  </div>
</body></html>`);

function element(id: string): Element {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing fixture element #${id}`);
  return found;
}

function click(target: Element | null, overrides: Partial<ComposerRefocusClick> = {}): ComposerRefocusClick {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    detail: 1,
    metaKey: false,
    shiftKey: false,
    target,
    ...overrides,
  };
}

const collapsed = { isCollapsed: true };
const dragSelection = { isCollapsed: false };

describe('composerRefocusDecision', () => {
  test('blank-space click refocuses with no control', () => {
    expect(composerRefocusDecision(click(element('blank')), collapsed))
      .toEqual({ refocus: true, control: null });
  });

  test('plain transcript text click refocuses when the selection stayed collapsed', () => {
    expect(composerRefocusDecision(click(element('prose')), collapsed))
      .toEqual({ refocus: true, control: null });
  });

  test('one-shot button click refocuses and reports the button as the clicked control', () => {
    const decision = composerRefocusDecision(click(element('copy-glyph')), collapsed);
    expect(decision).toEqual({ refocus: true, control: element('copy') });
  });

  test('summary disclosure toggle counts as a one-shot control', () => {
    const decision = composerRefocusDecision(click(element('disclosure')), collapsed);
    expect(decision).toEqual({ refocus: true, control: element('disclosure') });
  });

  test('links and node references keep focus where the browser put it', () => {
    expect(composerRefocusDecision(click(element('node-ref-label')), collapsed))
      .toEqual({ refocus: false });
  });

  test('typing surfaces own their focus', () => {
    expect(composerRefocusDecision(click(element('editor-text')), collapsed)).toEqual({ refocus: false });
    expect(composerRefocusDecision(click(element('field')), collapsed)).toEqual({ refocus: false });
  });

  test('a click that produced a text selection is claimed by copying', () => {
    expect(composerRefocusDecision(click(element('prose')), dragSelection)).toEqual({ refocus: false });
  });

  test('keyboard-activated clicks (detail 0) never move focus', () => {
    expect(composerRefocusDecision(click(element('copy'), { detail: 0 }), collapsed))
      .toEqual({ refocus: false });
  });

  test('modified and non-primary clicks are left alone', () => {
    expect(composerRefocusDecision(click(element('blank'), { shiftKey: true }), collapsed))
      .toEqual({ refocus: false });
    expect(composerRefocusDecision(click(element('blank'), { metaKey: true }), collapsed))
      .toEqual({ refocus: false });
    expect(composerRefocusDecision(click(element('blank'), { button: 1 }), collapsed))
      .toEqual({ refocus: false });
  });
});

describe('clickInstalledFocusTarget', () => {
  const body = document.body;

  test('focus resting on the clicked control means nothing claimed it', () => {
    expect(clickInstalledFocusTarget(element('copy'), element('copy'), body)).toBe(false);
  });

  test('focus fallen to the body means nothing claimed it', () => {
    expect(clickInstalledFocusTarget(body, null, body)).toBe(false);
    expect(clickInstalledFocusTarget(null, element('copy'), body)).toBe(false);
  });

  test('a self-focusing surface (popover, dialog, inline editor) keeps its claim', () => {
    expect(clickInstalledFocusTarget(element('popover'), null, body)).toBe(true);
    expect(clickInstalledFocusTarget(element('editor'), element('copy'), body)).toBe(true);
  });
});
