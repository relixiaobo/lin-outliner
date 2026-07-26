const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PRESENTATIONML_NAMESPACE = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWINGML_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CHART_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const PRESENTATION_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const NOTES_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const CHART_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

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
} = {}): StoredZipEntry[] {
  const firstSlideText = options.firstSlideText ?? 'First slide';
  const hasSecondSlide = options.secondSlideText !== undefined;
  const presentationIds = hasSecondSlide
    ? '<p:sldId id="256" r:id="rIdSecond"/><p:sldId id="257" r:id="rIdFirst"/>'
    : '<p:sldId id="256" r:id="rIdFirst"/>';
  const presentationRelationships = [
    relationship('rIdFirst', PRESENTATION_RELATIONSHIP_TYPE, 'slides/slide1.xml'),
    ...(hasSecondSlide ? [relationship('rIdSecond', PRESENTATION_RELATIONSHIP_TYPE, 'slides/slide2.xml')] : []),
  ].join('');
  const firstSlideRelationships = [
    ...(options.notesText ? [relationship('rIdNotes', NOTES_RELATIONSHIP_TYPE, '../notesSlides/notesSlide1.xml')] : []),
    ...(options.chartValues ? [relationship('rIdChart', CHART_RELATIONSHIP_TYPE, '../charts/chart1.xml')] : []),
  ];

  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${PRESENTATIONML_NAMESPACE}" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"><p:sldIdLst>${presentationIds}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: relationshipsXml(presentationRelationships),
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: slideXml(firstSlideText),
    },
    ...(firstSlideRelationships.length > 0 ? [{
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: relationshipsXml(firstSlideRelationships.join('')),
    }] : []),
    ...(hasSecondSlide ? [{
      name: 'ppt/slides/slide2.xml',
      data: slideXml(options.secondSlideText ?? ''),
    }] : []),
    ...(options.notesText ? [{
      name: 'ppt/notesSlides/notesSlide1.xml',
      data: slideXml(options.notesText),
    }] : []),
    ...(options.chartValues ? [{
      name: 'ppt/charts/chart1.xml',
      data: chartXml(options.chartValues),
    }] : []),
    ...(options.extraEntries ?? []),
  ];
}

function slideXml(text: string): string {
  const paragraphs = text
    ? text.split('\n').map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join('')
    : '<a:p/>';
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${PRESENTATIONML_NAMESPACE}" xmlns:a="${DRAWINGML_NAMESPACE}"><p:cSld><p:spTree>${paragraphs}</p:spTree></p:cSld></p:sld>`;
}

function chartXml(values: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${CHART_NAMESPACE}" xmlns:a="${DRAWINGML_NAMESPACE}"><c:chart>${values.map((value) => `<c:v>${escapeXml(value)}</c:v>`).join('')}</c:chart></c:chartSpace>`;
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
