const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const TRANSITIONAL_PRESENTATIONML_NAMESPACE = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const STRICT_PRESENTATIONML_NAMESPACE = 'http://purl.oclc.org/ooxml/presentationml/main';
const TRANSITIONAL_DRAWINGML_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const STRICT_DRAWINGML_NAMESPACE = 'http://purl.oclc.org/ooxml/drawingml/main';
const TRANSITIONAL_OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_OFFICE_RELATIONSHIPS_NAMESPACE = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TRANSITIONAL_CHART_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const STRICT_CHART_NAMESPACE = 'http://purl.oclc.org/ooxml/drawingml/chart';
const PRESENTATION_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

export interface StoredZipEntry {
  readonly name: string;
  readonly data: string | Uint8Array;
}

export function buildStoredZip(entries: StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function pptxFixtureEntries(options: {
  firstSlideText?: string;
  secondSlideText?: string | null;
  notesText?: string;
  chartValues?: string[];
  extraEntries?: StoredZipEntry[];
  strict?: boolean;
} = {}): StoredZipEntry[] {
  const presentationNamespace = options.strict
    ? STRICT_PRESENTATIONML_NAMESPACE
    : TRANSITIONAL_PRESENTATIONML_NAMESPACE;
  const drawingNamespace = options.strict ? STRICT_DRAWINGML_NAMESPACE : TRANSITIONAL_DRAWINGML_NAMESPACE;
  const chartNamespace = options.strict ? STRICT_CHART_NAMESPACE : TRANSITIONAL_CHART_NAMESPACE;
  const officeRelationshipsNamespace = options.strict
    ? STRICT_OFFICE_RELATIONSHIPS_NAMESPACE
    : TRANSITIONAL_OFFICE_RELATIONSHIPS_NAMESPACE;
  const relationshipType = (name: string) => `${officeRelationshipsNamespace}/${name}`;
  const firstSlideText = options.firstSlideText ?? 'First slide';
  const hasSecondSlide = options.secondSlideText !== undefined;
  const presentationIds = hasSecondSlide
    ? '<p:sldId id="256" r:id="rIdSecond"/><p:sldId id="257" r:id="rIdFirst"/>'
    : '<p:sldId id="256" r:id="rIdFirst"/>';
  const presentationRelationships = [
    relationship('rIdFirst', relationshipType('slide'), 'slides/slide1.xml'),
    ...(hasSecondSlide ? [relationship('rIdSecond', relationshipType('slide'), 'slides/slide2.xml')] : []),
  ].join('');
  const firstSlideRelationships = [
    ...(options.notesText ? [relationship('rIdNotes', relationshipType('notesSlide'), '../notesSlides/notesSlide1.xml')] : []),
    ...(options.chartValues ? [relationship('rIdChart', relationshipType('chart'), '../charts/chart1.xml')] : []),
  ];
  const contentTypeOverrides = [
    contentTypeOverride('/ppt/presentation.xml', PRESENTATION_CONTENT_TYPE),
    contentTypeOverride('/ppt/slides/slide1.xml', SLIDE_CONTENT_TYPE),
    ...(hasSecondSlide ? [contentTypeOverride('/ppt/slides/slide2.xml', SLIDE_CONTENT_TYPE)] : []),
    ...(options.notesText ? [contentTypeOverride('/ppt/notesSlides/notesSlide1.xml', NOTES_SLIDE_CONTENT_TYPE)] : []),
    ...(options.chartValues ? [contentTypeOverride('/ppt/charts/chart1.xml', CHART_CONTENT_TYPE)] : []),
  ].join('');

  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}">${contentTypeOverrides}</Types>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${presentationNamespace}" xmlns:r="${officeRelationshipsNamespace}"><p:sldIdLst>${presentationIds}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: relationshipsXml(presentationRelationships),
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: slideXml(firstSlideText, presentationNamespace, drawingNamespace),
    },
    ...(firstSlideRelationships.length > 0 ? [{
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: relationshipsXml(firstSlideRelationships.join('')),
    }] : []),
    ...(hasSecondSlide ? [{
      name: 'ppt/slides/slide2.xml',
      data: slideXml(options.secondSlideText ?? '', presentationNamespace, drawingNamespace),
    }] : []),
    ...(options.notesText ? [{
      name: 'ppt/notesSlides/notesSlide1.xml',
      data: slideXml(options.notesText, presentationNamespace, drawingNamespace),
    }] : []),
    ...(options.chartValues ? [{
      name: 'ppt/charts/chart1.xml',
      data: chartXml(options.chartValues, chartNamespace, drawingNamespace),
    }] : []),
    ...(options.extraEntries ?? []),
  ];
}

function slideXml(text: string, presentationNamespace: string, drawingNamespace: string): string {
  const paragraphs = text
    ? text.split('\n').map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join('')
    : '<a:p/>';
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}"><p:cSld><p:spTree>${paragraphs}</p:spTree></p:cSld></p:sld>`;
}

function chartXml(values: string[], chartNamespace: string, drawingNamespace: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${chartNamespace}" xmlns:a="${drawingNamespace}"><c:chart>${values.map((value) => `<c:v>${escapeXml(value)}</c:v>`).join('')}</c:chart></c:chartSpace>`;
}

function contentTypeOverride(partName: string, contentType: string): string {
  return `<Override PartName="${partName}" ContentType="${contentType}"/>`;
}

function relationshipsXml(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">${content}</Relationships>`;
}

function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
