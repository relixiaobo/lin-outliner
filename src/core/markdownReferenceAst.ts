import {
  parseReferenceMarkers,
  type ParsedReferenceMarker,
  type ReferenceUriScheme,
} from './referenceMarkup';

const REFERENCE_OPAQUE_NODE_TYPES = new Set([
  'code',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
]);

export interface MarkdownReferenceAstNode {
  children?: MarkdownReferenceAstNode[];
  position?: {
    end?: { offset?: number };
    start?: { offset?: number };
  };
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
}

export interface MarkdownReferenceOccurrence {
  readonly escaped: boolean;
  readonly marker: ParsedReferenceMarker;
  readonly sourceStart: number | null;
}

export interface MarkdownReferenceOccurrenceResult {
  readonly indeterminate: boolean;
  readonly occurrences: readonly MarkdownReferenceOccurrence[];
}

interface MarkdownSourceAlignmentStep {
  readonly advancesSource: boolean;
  readonly next: MarkdownSourceAlignment;
  readonly sourceOffset: number;
  readonly valueLength: number;
}

interface PendingMarkdownSourceAlignmentStep {
  advancesSource: boolean;
  sourceOffset: number;
  valueLength: number;
}

const MARKDOWN_SOURCE_ALIGNMENT_END = Symbol('markdown-source-alignment-end');
type MarkdownSourceAlignment = MarkdownSourceAlignmentStep | typeof MARKDOWN_SOURCE_ALIGNMENT_END;

export function transformMarkdownReferenceTextNodes(
  node: MarkdownReferenceAstNode,
  transformText: (value: string, node: MarkdownReferenceAstNode) => readonly MarkdownReferenceAstNode[],
): void {
  if (!node.children || REFERENCE_OPAQUE_NODE_TYPES.has(node.type)) return;
  const nextChildren: MarkdownReferenceAstNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      nextChildren.push(...transformText(child.value, child));
      continue;
    }
    transformMarkdownReferenceTextNodes(child, transformText);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function markdownReferenceOccurrences(
  markdown: string,
  value: string,
  node: MarkdownReferenceAstNode,
  admittedSchemes?: readonly ReferenceUriScheme[],
): MarkdownReferenceOccurrenceResult {
  const markers = parseReferenceMarkers(value, admittedSchemes, { includeEscaped: true });
  if (markers.length === 0) return { occurrences: [], indeterminate: false };
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return { occurrences: [], indeterminate: true };
  }
  const source = markdown.slice(start, end);
  try {
    const sourceOffsets = normalizedMarkdownSourceOffsets(source, value);
    if (!sourceOffsets) return { occurrences: [], indeterminate: true };
    return {
      indeterminate: false,
      occurrences: markers.map((marker) => {
        const sourceOffset = sourceOffsets[marker.start];
        return {
          marker,
          escaped: sourceOffset === undefined || isEscapedAt(source, sourceOffset),
          sourceStart: sourceOffset === undefined ? null : start + sourceOffset,
        };
      }),
    };
  } catch {
    return { occurrences: [], indeterminate: true };
  }
}

function normalizedMarkdownSourceOffsets(source: string, value: string): readonly number[] | null {
  const memo = new Map<string, MarkdownSourceAlignment | null>();
  const alignment = alignNormalizedMarkdownSource(source, value, 0, 0, memo);
  if (!alignment) return null;
  const offsets: number[] = [];
  let valueIndex = 0;
  let step = alignment;
  while (step !== MARKDOWN_SOURCE_ALIGNMENT_END) {
    for (let index = 0; index < step.valueLength; index += 1) {
      offsets[valueIndex + index] = step.sourceOffset + (step.advancesSource ? index : 0);
    }
    valueIndex += step.valueLength;
    step = step.next;
  }
  return offsets;
}

function alignNormalizedMarkdownSource(
  source: string,
  value: string,
  initialSourceIndex: number,
  initialValueIndex: number,
  memo: Map<string, MarkdownSourceAlignment | null>,
): MarkdownSourceAlignment | null {
  const key = `${initialSourceIndex}:${initialValueIndex}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const localSteps: PendingMarkdownSourceAlignmentStep[] = [];
  let sourceIndex = initialSourceIndex;
  let valueIndex = initialValueIndex;
  while (sourceIndex < source.length && valueIndex < value.length) {
    const escaped = escapedMarkdownCharacter(source, sourceIndex, value, valueIndex);
    if (escaped) {
      appendAlignmentStep(localSteps, {
        advancesSource: false,
        sourceOffset: sourceIndex + 1,
        valueLength: escaped.valueLength,
      });
      sourceIndex += 1 + escaped.sourceLength;
      valueIndex += escaped.valueLength;
      continue;
    }

    const entityEnd = markdownEntityEnd(source, sourceIndex);
    if (entityEnd >= 0) {
      const rawEntity = source.slice(sourceIndex, entityEnd + 1);
      if (!value.startsWith(rawEntity, valueIndex)) {
        for (const valueLength of nextEntityValueLengths(value, valueIndex)) {
          const tail = alignNormalizedMarkdownSource(
            source,
            value,
            entityEnd + 1,
            valueIndex + valueLength,
            memo,
          );
          if (!tail) continue;
          const result = prependAlignmentSteps(localSteps, {
            advancesSource: false,
            next: tail,
            sourceOffset: sourceIndex,
            valueLength,
          });
          memo.set(key, result);
          return result;
        }
        memo.set(key, null);
        return null;
      }
    }

    if (source.startsWith('\r\n', sourceIndex) && value[valueIndex] === '\n') {
      appendAlignmentStep(localSteps, { advancesSource: false, sourceOffset: sourceIndex, valueLength: 1 });
      sourceIndex += 2;
      valueIndex += 1;
      continue;
    }

    const sourceLength = codePointLengthAt(source, sourceIndex);
    const valueLength = codePointLengthAt(value, valueIndex);
    if (source.slice(sourceIndex, sourceIndex + sourceLength) !== value.slice(valueIndex, valueIndex + valueLength)) {
      memo.set(key, null);
      return null;
    }
    appendAlignmentStep(localSteps, { advancesSource: true, sourceOffset: sourceIndex, valueLength });
    sourceIndex += sourceLength;
    valueIndex += valueLength;
  }
  if (sourceIndex !== source.length || valueIndex !== value.length) {
    memo.set(key, null);
    return null;
  }
  const result = prependAlignmentSteps(localSteps, MARKDOWN_SOURCE_ALIGNMENT_END);
  memo.set(key, result);
  return result;
}

function prependAlignmentSteps(
  steps: readonly PendingMarkdownSourceAlignmentStep[],
  tail: MarkdownSourceAlignment,
): MarkdownSourceAlignment {
  let result = tail;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    result = { ...steps[index]!, next: result };
  }
  return result;
}

function appendAlignmentStep(
  steps: PendingMarkdownSourceAlignmentStep[],
  step: PendingMarkdownSourceAlignmentStep,
): void {
  const previous = steps[steps.length - 1];
  if (
    previous?.advancesSource
    && step.advancesSource
    && previous.sourceOffset + previous.valueLength === step.sourceOffset
  ) {
    previous.valueLength += step.valueLength;
    return;
  }
  steps.push(step);
}

function nextEntityValueLengths(value: string, start: number): readonly number[] {
  const first = codePointLengthAt(value, start);
  if (first === 0) return [];
  const second = codePointLengthAt(value, start + first);
  return second === 0 ? [first] : [first, first + second];
}

function escapedMarkdownCharacter(
  source: string,
  sourceIndex: number,
  value: string,
  valueIndex: number,
): { readonly sourceLength: number; readonly valueLength: number } | null {
  if (source[sourceIndex] !== '\\') return null;
  const sourceLength = codePointLengthAt(source, sourceIndex + 1);
  if (sourceLength === 0) return null;
  const escaped = source.slice(sourceIndex + 1, sourceIndex + 1 + sourceLength);
  if (!/^[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]$/u.test(escaped)) return null;
  const valueLength = codePointLengthAt(value, valueIndex);
  return value.slice(valueIndex, valueIndex + valueLength) === escaped
    ? { sourceLength, valueLength }
    : null;
}

function markdownEntityEnd(source: string, start: number): number {
  if (source[start] !== '&') return -1;
  const match = /^&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/u.exec(source.slice(start));
  return match ? start + match[0].length - 1 : -1;
}

function codePointLengthAt(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? 0 : codePoint > 0xffff ? 2 : 1;
}

function isEscapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}
