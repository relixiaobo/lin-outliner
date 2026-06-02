import { Schema } from 'prosemirror-model';

export const pmSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM() {
        return ['p', 0];
      },
    },
    text: { group: 'inline' },
    inlineReference: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        targetKind: { default: 'node' },
        targetNodeId: { default: '' },
        targetPath: { default: '' },
        entryKind: { default: 'file' },
        displayName: { default: '' },
        mimeType: { default: '' },
        sizeBytes: { default: null },
        color: { default: '' },
      },
      parseDOM: [{
        tag: 'span[data-inline-ref-kind]',
        getAttrs(dom) {
          const element = dom as HTMLElement;
          return {
            targetKind: element.dataset.inlineRefKind ?? 'node',
            targetNodeId: element.dataset.inlineRef ?? '',
            targetPath: element.dataset.inlineRefPath ?? '',
            entryKind: element.dataset.inlineRefEntryKind ?? 'file',
            displayName: element.textContent?.replace(/^@/, '').trim() ?? '',
          };
        },
      }],
      toDOM(node) {
        const attrs: Record<string, string> = {
          class: 'inline-ref',
          'data-inline-ref-kind': String(node.attrs.targetKind ?? 'node'),
          contenteditable: 'false',
        };
        if (node.attrs.targetKind === 'node') attrs['data-inline-ref'] = String(node.attrs.targetNodeId ?? '');
        if (node.attrs.targetKind === 'local-file') {
          attrs['data-inline-ref-path'] = String(node.attrs.targetPath ?? '');
          attrs['data-inline-ref-entry-kind'] = String(node.attrs.entryKind ?? 'file');
        }
        if (node.attrs.color) {
          attrs.style = `color: ${node.attrs.color}; --inline-ref-accent: ${node.attrs.color}`;
        }
        return [
          'span',
          attrs,
          node.attrs.displayName || 'Referenced node',
        ];
      },
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM() {
        return ['strong', 0];
      },
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM() {
        return ['em', 0];
      },
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }],
      toDOM() {
        return ['s', 0];
      },
    },
    code: {
      inclusive: false,
      parseDOM: [{ tag: 'code' }],
      toDOM() {
        return ['code', { class: 'pm-code' }, 0];
      },
    },
    highlight: {
      parseDOM: [{ tag: 'mark' }],
      toDOM() {
        return ['mark', { class: 'pm-highlight' }, 0];
      },
    },
    headingMark: {
      parseDOM: [{ tag: 'span[data-heading-mark]' }],
      toDOM() {
        return ['span', { 'data-heading-mark': 'true' }, 0];
      },
    },
    link: {
      attrs: { href: { default: '' } },
      inclusive: false,
      parseDOM: [{
        tag: 'a[href]',
        getAttrs(dom) {
          return { href: (dom as HTMLAnchorElement).getAttribute('href') ?? '' };
        },
      }],
      toDOM(node) {
        return ['a', { href: node.attrs.href, title: node.attrs.href }, 0];
      },
    },
  },
});
