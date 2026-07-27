import path from 'node:path';
import type { Readable } from 'node:stream';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import * as yauzl from 'yauzl';
import { AgentFileIngestionFailure } from './agentFileIngestion';
import { throwIfAborted } from './agentAwaitWithAbort';

const CONTENT_TYPES_PART = '[Content_Types].xml';
const PRESENTATION_PART = 'ppt/presentation.xml';
const PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';
const TRANSITIONAL_DRAWINGML_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const STRICT_DRAWINGML_NAMESPACE = 'http://purl.oclc.org/ooxml/drawingml/main';
const TRANSITIONAL_PRESENTATIONML_NAMESPACE = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const STRICT_PRESENTATIONML_NAMESPACE = 'http://purl.oclc.org/ooxml/presentationml/main';
const TRANSITIONAL_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_RELATIONSHIPS_NAMESPACE = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PPTX_PRESENTATION_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const PPTX_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const PPTX_NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const PPTX_CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const PPTX_TRUNCATION_MARKER = '\n\n[PPTX structural text output truncated]';

const DRAWINGML_NAMESPACES = new Set<string>([
  TRANSITIONAL_DRAWINGML_NAMESPACE,
  STRICT_DRAWINGML_NAMESPACE,
]);
const PRESENTATION_RELATIONSHIP_NAMESPACES = new Map<string, string>([
  [TRANSITIONAL_PRESENTATIONML_NAMESPACE, TRANSITIONAL_RELATIONSHIPS_NAMESPACE],
  [STRICT_PRESENTATIONML_NAMESPACE, STRICT_RELATIONSHIPS_NAMESPACE],
]);
const SLIDE_RELATIONSHIP_TYPES = relationshipTypeSet('slide');
const NOTES_SLIDE_RELATIONSHIP_TYPES = relationshipTypeSet('notesSlide');
const CHART_RELATIONSHIP_TYPES = relationshipTypeSet('chart');

function relationshipTypeSet(name: string): ReadonlySet<string> {
  return new Set([
    `${TRANSITIONAL_RELATIONSHIPS_NAMESPACE}/${name}`,
    `${STRICT_RELATIONSHIPS_NAMESPACE}/${name}`,
  ]);
}

export interface PptxIngestionBudgets {
  readonly maxArchiveEntries: number;
  readonly maxPartBytes: number;
  readonly maxSelectedXmlBytes: number;
  readonly maxSlides: number;
  readonly maxOutputChars: number;
  readonly timeoutMs: number;
}

export interface PptxIngestionResult {
  readonly content: string;
  readonly converter: 'pptx-structural';
  readonly contentChars: number;
  readonly truncated: boolean;
  readonly totalSlides: number;
  readonly slidesWithoutText: number[];
  readonly notesSlides: number;
  readonly chartCount: number;
}

export const DEFAULT_PPTX_INGESTION_BUDGETS: PptxIngestionBudgets = {
  maxArchiveEntries: 20_000,
  maxPartBytes: 8 * 1024 * 1024,
  maxSelectedXmlBytes: 64 * 1024 * 1024,
  maxSlides: 1_000,
  maxOutputChars: 80_000,
  timeoutMs: 30_000,
};

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

interface ContentTypeManifest {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

interface SlideObservation {
  readonly text: string[];
  readonly notes: string[];
  readonly charts: Array<{ part: string; text: string[] }>;
}

interface ZipReadContext {
  readonly zip: yauzl.ZipFile;
  readonly entries: ReadonlyMap<string, yauzl.Entry>;
  readonly budgets: PptxIngestionBudgets;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly cache: Map<string, string>;
  selectedXmlBytes: number;
  activeStream: Readable | null;
}

export async function ingestPptxAsMarkdown(
  filePath: string,
  signal?: AbortSignal,
  budgetOverrides: Partial<PptxIngestionBudgets> = {},
): Promise<PptxIngestionResult> {
  const budgets = { ...DEFAULT_PPTX_INGESTION_BUDGETS, ...budgetOverrides };
  const deadline = Date.now() + budgets.timeoutMs;
  let zip: yauzl.ZipFile | null = null;
  let context: ZipReadContext | null = null;
  const abort = () => {
    context?.activeStream?.destroy(abortError(signal));
    zip?.close();
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    throwIfAborted(signal);
    zip = await yauzl.openPromise(filePath, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    throwIfAborted(signal);
    checkDeadline(deadline);
    if (zip.entryCount > budgets.maxArchiveEntries) {
      throw budgetFailure(`PPTX contains ${zip.entryCount} archive entries; the limit is ${budgets.maxArchiveEntries}.`);
    }

    const entries = new Map<string, yauzl.Entry>();
    for await (const entry of zip.eachEntry()) {
      throwIfAborted(signal);
      checkDeadline(deadline);
      if (entries.has(entry.fileName)) {
        throw invalidPptx(`PPTX contains a duplicate archive part: ${entry.fileName}.`);
      }
      entries.set(entry.fileName, entry);
    }

    context = {
      zip,
      entries,
      budgets,
      deadline,
      signal,
      cache: new Map(),
      selectedXmlBytes: 0,
      activeStream: null,
    };

    const contentTypes = parseContentTypes(await readRequiredXmlPart(context, CONTENT_TYPES_PART));
    assertPartContentType(contentTypes, PRESENTATION_PART, PPTX_PRESENTATION_CONTENT_TYPE, 'presentation');
    const presentationXml = await readRequiredXmlPart(context, PRESENTATION_PART);
    const presentationRelsXml = await readRequiredXmlPart(context, PRESENTATION_RELS_PART);
    const slideRelationshipIds = parsePresentationSlideIds(presentationXml);
    if (slideRelationshipIds.length > budgets.maxSlides) {
      throw budgetFailure(`PPTX contains ${slideRelationshipIds.length} slides; the limit is ${budgets.maxSlides}.`);
    }

    const presentationRelationships = relationshipsById(parseRelationships(presentationRelsXml));
    const slideParts = slideRelationshipIds.map((relationshipId) => {
      const relationship = presentationRelationships.get(relationshipId);
      if (!relationship || relationship.external || !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)) {
        throw invalidPptx(`Presentation slide relationship ${relationshipId} is missing or invalid.`);
      }
      const target = resolveInternalTarget(PRESENTATION_PART, relationship.target);
      assertPartContentType(contentTypes, target, PPTX_SLIDE_CONTENT_TYPE, 'slide');
      return target;
    });

    const slides: SlideObservation[] = [];
    const slidesWithoutText: number[] = [];
    let notesSlides = 0;
    let chartCount = 0;
    for (const [index, slidePart] of slideParts.entries()) {
      throwIfAborted(signal);
      checkDeadline(deadline);
      const slideText = extractDrawingText(await readRequiredXmlPart(context, slidePart));
      if (slideText.length === 0) slidesWithoutText.push(index + 1);

      const relationshipsPart = relationshipsPartFor(slidePart);
      const relationshipsXml = await readOptionalXmlPart(context, relationshipsPart);
      const relationships = relationshipsXml ? parseRelationships(relationshipsXml) : [];
      const notes: string[] = [];
      const charts: Array<{ part: string; text: string[] }> = [];
      const observedTargets = new Set<string>();
      for (const relationship of relationships) {
        if (relationship.external) continue;
        const isNotesSlide = NOTES_SLIDE_RELATIONSHIP_TYPES.has(relationship.type);
        const isChart = CHART_RELATIONSHIP_TYPES.has(relationship.type);
        if (!isNotesSlide && !isChart) continue;
        const target = resolveInternalTarget(slidePart, relationship.target);
        assertPartContentType(
          contentTypes,
          target,
          isNotesSlide ? PPTX_NOTES_SLIDE_CONTENT_TYPE : PPTX_CHART_CONTENT_TYPE,
          isNotesSlide ? 'notes slide' : 'chart',
        );
        if (observedTargets.has(target)) continue;
        observedTargets.add(target);
        if (isNotesSlide) {
          const noteText = extractDrawingText(await readRequiredXmlPart(context, target));
          notes.push(...noteText);
          if (noteText.length > 0) notesSlides += 1;
        } else {
          charts.push({ part: target, text: extractChartText(await readRequiredXmlPart(context, target)) });
          chartCount += 1;
        }
      }
      slides.push({ text: slideText, notes, charts });
    }

    const rendered = renderPptxMarkdown(slides, slidesWithoutText, notesSlides, chartCount);
    const truncated = rendered.length > budgets.maxOutputChars;
    return {
      content: truncated
        ? `${rendered.slice(0, budgets.maxOutputChars)}${PPTX_TRUNCATION_MARKER}`
        : rendered,
      converter: 'pptx-structural',
      contentChars: rendered.length,
      truncated,
      totalSlides: slides.length,
      slidesWithoutText,
      notesSlides,
      chartCount,
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AgentFileIngestionFailure) throw error;
    throw invalidPptx(errorMessage(error));
  } finally {
    signal?.removeEventListener('abort', abort);
    context?.activeStream?.destroy();
    zip?.close();
  }
}

async function readRequiredXmlPart(context: ZipReadContext, part: string): Promise<string> {
  const xml = await readOptionalXmlPart(context, part);
  if (xml === null) throw invalidPptx(`PPTX is missing required part ${part}.`);
  return xml;
}

async function readOptionalXmlPart(context: ZipReadContext, part: string): Promise<string | null> {
  const cached = context.cache.get(part);
  if (cached !== undefined) return cached;
  const entry = context.entries.get(part);
  if (!entry) return null;
  if (entry.fileName.endsWith('/')) throw invalidPptx(`PPTX part ${part} is a directory.`);
  if (entry.isEncrypted() || !entry.canDecodeFileData()) {
    throw invalidPptx(`PPTX part ${part} cannot be decoded.`);
  }
  if (entry.uncompressedSize > context.budgets.maxPartBytes) {
    throw budgetFailure(`PPTX XML part ${part} exceeds the ${context.budgets.maxPartBytes}-byte part limit.`);
  }
  if (context.selectedXmlBytes + entry.uncompressedSize > context.budgets.maxSelectedXmlBytes) {
    throw budgetFailure(`Selected PPTX XML exceeds the ${context.budgets.maxSelectedXmlBytes}-byte total limit.`);
  }
  context.selectedXmlBytes += entry.uncompressedSize;
  throwIfAborted(context.signal);
  checkDeadline(context.deadline);

  const stream = await context.zip.openReadStreamPromise(entry);
  context.activeStream = stream;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      throwIfAborted(context.signal);
      checkDeadline(context.deadline);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > context.budgets.maxPartBytes || bytes > entry.uncompressedSize) {
        throw budgetFailure(`PPTX XML part ${part} exceeded its declared or configured size limit while reading.`);
      }
      chunks.push(buffer);
    }
  } finally {
    context.activeStream = null;
  }
  const xml = decodeXml(Buffer.concat(chunks, bytes), part);
  context.cache.set(part, xml);
  return xml;
}

function parseContentTypes(xml: string): ContentTypeManifest {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  let rootSeen = false;
  parseXml(xml, CONTENT_TYPES_PART, (tag) => {
    if (!rootSeen) {
      rootSeen = true;
      if (tag.uri !== CONTENT_TYPES_NAMESPACE || tag.local !== 'Types') {
        throw invalidPptx('The OOXML content-types part has an invalid root element.');
      }
      return;
    }
    if (tag.uri !== CONTENT_TYPES_NAMESPACE) return;
    if (tag.local === 'Default') {
      const extension = attribute(tag, 'Extension')?.toLowerCase();
      const contentType = attribute(tag, 'ContentType');
      if (!extension || extension.includes('.') || !contentType) {
        throw invalidPptx('An OOXML default content type is invalid.');
      }
      if (defaults.has(extension)) throw invalidPptx(`Duplicate OOXML default content type for .${extension}.`);
      defaults.set(extension, contentType);
      return;
    }
    if (tag.local === 'Override') {
      const partName = attribute(tag, 'PartName');
      const contentType = attribute(tag, 'ContentType');
      if (!partName?.startsWith('/') || partName.includes('\\') || !contentType) {
        throw invalidPptx('An OOXML override content type is invalid.');
      }
      if (overrides.has(partName)) throw invalidPptx(`Duplicate OOXML content type override for ${partName}.`);
      overrides.set(partName, contentType);
    }
  });
  if (!rootSeen) throw invalidPptx('The OOXML content-types part is empty.');
  return { defaults, overrides };
}

function assertPartContentType(
  manifest: ContentTypeManifest,
  part: string,
  expected: string,
  role: string,
): void {
  const extension = path.posix.extname(part).slice(1).toLowerCase();
  const actual = manifest.overrides.get(`/${part}`) ?? manifest.defaults.get(extension);
  if (actual !== expected) {
    throw invalidPptx(`PPTX ${role} part ${part} has an invalid content type.`);
  }
}

function parsePresentationSlideIds(xml: string): string[] {
  const relationshipIds: string[] = [];
  let presentationNamespace: string | null = null;
  let relationshipNamespace: string | null = null;
  parseXml(xml, PRESENTATION_PART, (tag) => {
    if (presentationNamespace === null) {
      const expectedRelationshipNamespace = PRESENTATION_RELATIONSHIP_NAMESPACES.get(tag.uri);
      if (tag.local !== 'presentation' || !expectedRelationshipNamespace) {
        throw invalidPptx('The OOXML presentation part has an invalid root element or namespace.');
      }
      presentationNamespace = tag.uri;
      relationshipNamespace = expectedRelationshipNamespace;
      return;
    }
    if (tag.uri !== presentationNamespace || tag.local !== 'sldId') return;
    const relationshipId = attribute(tag, 'id', relationshipNamespace ?? undefined);
    if (!relationshipId) throw invalidPptx('A presentation slide is missing its relationship id.');
    relationshipIds.push(relationshipId);
  });
  if (presentationNamespace === null) throw invalidPptx('The OOXML presentation part is empty.');
  return relationshipIds;
}

function parseRelationships(xml: string): Relationship[] {
  const relationships: Relationship[] = [];
  let rootSeen = false;
  parseXml(xml, 'relationships part', (tag) => {
    if (!rootSeen) {
      rootSeen = true;
      if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationships') {
        throw invalidPptx('An OOXML relationships part has an invalid root element.');
      }
      return;
    }
    if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationship') return;
    const id = attribute(tag, 'Id');
    const type = attribute(tag, 'Type');
    const target = attribute(tag, 'Target');
    if (!id || !type || !target) throw invalidPptx('An OOXML relationship is missing Id, Type, or Target.');
    relationships.push({
      id,
      type,
      target,
      external: attribute(tag, 'TargetMode')?.toLowerCase() === 'external',
    });
  });
  if (!rootSeen) throw invalidPptx('An OOXML relationships part is empty.');
  return relationships;
}

function relationshipsById(relationships: Relationship[]): Map<string, Relationship> {
  const byId = new Map<string, Relationship>();
  for (const relationship of relationships) {
    if (byId.has(relationship.id)) throw invalidPptx(`Duplicate OOXML relationship id ${relationship.id}.`);
    byId.set(relationship.id, relationship);
  }
  return byId;
}

function extractDrawingText(xml: string): string[] {
  const paragraphs: string[] = [];
  let paragraph: string[] | null = null;
  let readingText = false;
  parseXml(
    xml,
    'DrawingML part',
    (tag) => {
      if (!DRAWINGML_NAMESPACES.has(tag.uri)) return;
      if (tag.local === 'p') paragraph = [];
      if (tag.local === 't') readingText = true;
      if (tag.local === 'br' && paragraph) paragraph.push('\n');
      if (tag.local === 'tab' && paragraph) paragraph.push('\t');
    },
    (tag) => {
      if (!DRAWINGML_NAMESPACES.has(tag.uri)) return;
      if (tag.local === 't') readingText = false;
      if (tag.local === 'p' && paragraph) {
        const text = normalizeObservedText(paragraph.join(''));
        if (text) paragraphs.push(text);
        paragraph = null;
      }
    },
    (text) => {
      if (readingText && paragraph) paragraph.push(text);
    },
  );
  return paragraphs;
}

function extractChartText(xml: string): string[] {
  const drawingText = extractDrawingText(xml);
  const values: string[] = [];
  let readingChartValue = false;
  let current = '';
  parseXml(
    xml,
    'chart part',
    (tag) => {
      if (tag.local === 'v') {
        readingChartValue = true;
        current = '';
      }
    },
    (tag) => {
      if (tag.local !== 'v' || !readingChartValue) return;
      const value = normalizeObservedText(current);
      if (value) values.push(value);
      readingChartValue = false;
      current = '';
    },
    (text) => {
      if (readingChartValue) current += text;
    },
  );
  return uniqueStrings([...drawingText, ...values]);
}

function parseXml(
  xml: string,
  part: string,
  onOpen: (tag: SaxesTagNS) => void,
  onClose: (tag: SaxesTagNS) => void = () => {},
  onText: (text: string) => void = () => {},
): void {
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => {
      throw invalidPptx(`DOCTYPE is not allowed in ${part}.`);
    });
    parser.on('opentag', onOpen);
    parser.on('closetag', onClose);
    parser.on('text', onText);
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof AgentFileIngestionFailure) throw error;
    throw invalidPptx(`Malformed XML in ${part}: ${errorMessage(error)}`);
  }
}

function renderPptxMarkdown(
  slides: SlideObservation[],
  slidesWithoutText: number[],
  notesSlides: number,
  chartCount: number,
): string {
  const output = [
    '# PPTX structural text',
    '',
    '> Extracted locally from OOXML. Images, visual layout, animations, embedded files, and OCR are not included.',
    '',
    `Slides: ${slides.length}; slides without structured text: ${slidesWithoutText.length}; slides with speaker notes: ${notesSlides}; related charts: ${chartCount}.`,
  ];
  for (const [index, slide] of slides.entries()) {
    output.push('', `## Slide ${index + 1}`, '');
    if (slide.text.length > 0) {
      output.push(slide.text.join('\n'));
    } else {
      output.push('[No structured text found. This slide may contain only visual content.]');
    }
    if (slide.notes.length > 0) {
      output.push('', '### Speaker notes', '', slide.notes.join('\n'));
    }
    for (const [chartIndex, chart] of slide.charts.entries()) {
      output.push('', `### Chart ${chartIndex + 1}`, '');
      output.push(chart.text.length > 0
        ? chart.text.join('\n')
        : `[No structured chart text found in ${chart.part}.]`);
    }
  }
  return output.join('\n').trim();
}

function resolveInternalTarget(sourcePart: string, target: string): string {
  if (target.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    throw invalidPptx(`Unsafe internal relationship target: ${target}.`);
  }
  let decoded: string;
  try {
    decoded = decodeURI(target.split('#', 1)[0]!);
  } catch {
    throw invalidPptx(`Invalid relationship target encoding: ${target}.`);
  }
  const candidate = decoded.startsWith('/')
    ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(sourcePart), decoded);
  const normalized = path.posix.normalize(candidate);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw invalidPptx(`Relationship target escapes the OOXML package: ${target}.`);
  }
  return normalized;
}

function relationshipsPartFor(part: string): string {
  return path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
}

function decodeXml(buffer: Buffer, part: string): string {
  if (buffer.length === 0) throw invalidPptx(`PPTX XML part ${part} is empty.`);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  return buffer.subarray(start).toString('utf8');
}

function attribute(tag: SaxesTagNS, local: string, uri?: string): string | undefined {
  for (const value of Object.values(tag.attributes)) {
    if (value.local === local && (uri === undefined || value.uri === uri)) return value.value;
  }
  return undefined;
}

function normalizeObservedText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function checkDeadline(deadline: number): void {
  if (Date.now() < deadline) return;
  throw new AgentFileIngestionFailure(
    'pptx_timeout',
    'PPTX structural text extraction timed out.',
    'Try a smaller presentation or split the presentation, then retry file_read.',
  );
}

function invalidPptx(message: string): AgentFileIngestionFailure {
  return new AgentFileIngestionFailure(
    'invalid_pptx',
    message,
    'Choose a valid .pptx presentation. If the file is currently open in Office, choose the original document rather than its temporary ownership file.',
  );
}

function budgetFailure(message: string): AgentFileIngestionFailure {
  return new AgentFileIngestionFailure(
    'pptx_budget_exceeded',
    message,
    'Split the presentation or remove unusually large structured XML content, then retry file_read.',
  );
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
