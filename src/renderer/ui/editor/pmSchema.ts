import { Schema } from 'prosemirror-model';
import { basenameForPath } from '../../../core/referenceMarkup';
import { inlineFileIconDomSpec, inlineFileIconKind } from './inlineFileIcon';

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
            mimeType: element.dataset.inlineRefMimeType ?? '',
            sizeBytes: Number(element.dataset.inlineRefSizeBytes ?? Number.NaN),
          };
        },
      }],
      toDOM(node) {
        const targetKind = String(node.attrs.targetKind ?? 'node');
        const displayName = String(node.attrs.displayName ?? '');
        const targetPath = String(node.attrs.targetPath ?? '');
        const fallbackName = targetKind === 'local-file'
          ? basenameForPath(targetPath) || 'Referenced file'
          : 'Referenced node';
        const attrs: Record<string, string> = {
          class: 'inline-ref',
          'data-inline-ref-kind': targetKind,
          contenteditable: 'false',
        };
        if (targetKind === 'node') attrs['data-inline-ref'] = String(node.attrs.targetNodeId ?? '');
        if (targetKind === 'local-file') {
          attrs['data-inline-ref-path'] = targetPath;
          attrs['data-inline-ref-entry-kind'] = String(node.attrs.entryKind ?? 'file');
          if (node.attrs.mimeType) attrs['data-inline-ref-mime-type'] = String(node.attrs.mimeType);
          if (typeof node.attrs.sizeBytes === 'number' && Number.isFinite(node.attrs.sizeBytes)) {
            attrs['data-inline-ref-size-bytes'] = String(node.attrs.sizeBytes);
          }
        }
        if (node.attrs.color) {
          attrs.style = `color: ${node.attrs.color}; --inline-ref-accent: ${node.attrs.color}`;
        }
        const label = displayName || fallbackName;
        if (targetKind === 'local-file') {
          const iconKind = inlineFileIconKind({
            entryKind: node.attrs.entryKind === 'directory' ? 'directory' : 'file',
            mimeType: String(node.attrs.mimeType ?? ''),
            name: displayName || basenameForPath(targetPath),
          });
          return ['span', attrs, inlineFileIconDomSpec(iconKind), label];
        }
        return ['span', attrs, label];
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
